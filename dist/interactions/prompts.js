/**
 * Durable chat-prompt bookkeeping. Ledger delivery receipts become
 * MessageRefs here; pending reads stay synchronous for inbound stage 8.
 * Settled prompts stop matching numbered/reply-to answers; their refs
 * remain so settlement can edit the delivered platform message.
 */
import { JsonFile } from "../state/json-file.js";
export class PromptStore {
    file;
    rows;
    settled;
    /** identity → outcome text, recorded at settlement (Phase B timestamps). */
    outcomes = new Map();
    constructor(path) {
        this.file = new JsonFile(path, () => ({ prompts: [], settled: [] }));
        const state = this.file.readSync();
        this.rows = state.prompts;
        this.settled = new Set(state.settled);
    }
    /** Record a delivered prompt ref (idempotent for one recipient key). */
    async record(conversationId, callId, key, ref, plan) {
        const state = await this.file.update((draft) => {
            const identity = `${conversationId}:${callId}:${key}`;
            // A settlement raced the receipt: preserve the newly delivered
            // ref for the edit, never re-open the prompt for answers.
            if (draft.settled.includes(identity) && ref.messageId === "")
                return;
            const existing = draft.prompts.find((row) => row.conversationId === conversationId && row.callId === callId && row.key === key);
            const next = { conversationId, callId, key, ref, plan };
            if (existing === undefined)
                draft.prompts.push(next);
            else
                draft.prompts[draft.prompts.indexOf(existing)] = next;
        });
        this.rows = state.prompts;
        this.settled = new Set(state.settled);
    }
    /** All delivered message refs for settlement edits (including settled). */
    refsOf(conversationId, callId) {
        return this.rows
            .filter((row) => row.conversationId === conversationId && row.callId === callId)
            .map((row) => row.ref);
    }
    /** Whether this recipient/chat already has a prompt recorded. */
    has(conversationId, callId, key) {
        return this.rows.some((row) => row.conversationId === conversationId && row.callId === callId && row.key === key);
    }
    /** Recipient identities for opaque-key receipt correlation. */
    pendingRecipients(conversationId) {
        return this.rows
            .filter((row) => row.conversationId === conversationId)
            .map((row) => ({ callId: row.callId, key: row.key }));
    }
    /** Recipient keys for receipt correlation (opaque binding keys may contain colons). */
    keysOf(conversationId, callId) {
        return this.rows
            .filter((row) => row.conversationId === conversationId && row.callId === callId)
            .map((row) => row.key);
    }
    /** Unsettled choice/text prompts in one chat (bound key or user home key). */
    pendingInChat(bindingKey) {
        return this.rows
            .filter((row) => row.key === bindingKey && !this.settled.has(identityOf(row)))
            .map((row) => ({ conversationId: row.conversationId, callId: row.callId, plan: row.plan }));
    }
    /** Find the prompt behind a reply-to platform message id. */
    byReplyTo(bindingKey, messageId) {
        const row = this.rows.find((candidate) => candidate.key === bindingKey &&
            candidate.ref.messageId === messageId &&
            !this.settled.has(identityOf(candidate)));
        return row === undefined
            ? undefined
            : { conversationId: row.conversationId, callId: row.callId, plan: row.plan };
    }
    /** A recipient has been enqueued even before its receipt supplies a ref. */
    async markEnqueued(conversationId, callId, key, plan) {
        await this.record(conversationId, callId, key, { chat: { chatId: "", chatType: "dm" }, messageId: "" }, plan);
    }
    /** Install the real refs after the interaction ledger entry is delivered. */
    async recordReceipt(conversationId, callId, key, chat, messageIds) {
        const existing = this.rows.find((row) => row.conversationId === conversationId && row.callId === callId && row.key === key);
        await this.record(conversationId, callId, key, { chat, messageId: messageIds[0] ?? "" }, existing?.plan ?? { kind: "webui" });
    }
    /** Retire pending answers while preserving refs for the settlement edit. */
    async settle(conversationId, callId, outcome = "answered") {
        const keys = this.rows
            .filter((row) => row.conversationId === conversationId && row.callId === callId)
            .map(identityOf);
        const state = await this.file.update((draft) => {
            draft.settled = [...new Set([...draft.settled, ...keys])];
        });
        for (const identity of keys)
            this.outcomes.set(identity, outcome);
        this.rows = state.prompts;
        this.settled = new Set(state.settled);
    }
    /**
     * The outcome text recorded at settlement, when this identity is
     * settled. The receipt path reads it to self-heal the prompt edit.
     */
    settledOutcome(conversationId, callId, key) {
        return this.outcomes.get(`${conversationId}:${callId}:${key}`);
    }
}
function identityOf(row) {
    return `${row.conversationId}:${row.callId}:${row.key}`;
}
