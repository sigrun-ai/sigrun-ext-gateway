/**
 * Durable chat-prompt bookkeeping. Ledger delivery receipts become
 * MessageRefs here; pending reads stay synchronous for inbound stage 8.
 * Settled prompts stop matching numbered/reply-to answers.
 *
 * Retention (release-readiness spec 4 §§2–4): the persisted file is
 * version 2 — `prompts` rows plus a `settled` tombstone map carrying
 * the settlement timestamp and outcome text. Seven days after
 * settlement the bulky row (refs/plan) expires; the compact tombstone
 * persists PERMANENTLY so a delayed receipt or replay can never
 * resurrect an answerable prompt. Pending rows are never age-pruned.
 * Pruning runs at store initialization and at most once per write (no
 * timer), through the one `prune` helper and its boundary predicate.
 * Refs/plans are therefore bounded by active prompts plus seven days
 * of settled history; the tombstone set is deliberately unbounded.
 */
import { JsonFile } from "../state/json-file.js";
/** Settled-row retention (matches the delivery ledger's seven days). */
export const PROMPT_RETENTION_MS = 604_800_000;
/** The persisted schema version (v1 = unversioned, `settled: string[]`). */
const PROMPT_FILE_VERSION = 2;
export class PromptStore {
    file;
    now;
    log;
    rows;
    settled;
    constructor(path, options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.log = options.log;
        this.file = new JsonFile(path, () => ({
            version: PROMPT_FILE_VERSION,
            prompts: [],
            settled: {},
        }));
        const state = this.file.readSync();
        const migrated = migrate(state, this.now(), this.log);
        // Initialization pruning rides the same helper the writes use.
        prune(migrated, this.now());
        // Persist the normalized/pruned shape ONLY when something changed:
        // a legacy or repaired file must not re-migrate on every boot,
        // while a healthy v2 file needs no rewrite at construction.
        if (JSON.stringify(state) !== JSON.stringify(migrated)) {
            this.file.updateSync((draft) => {
                draft.version = migrated.version;
                draft.prompts = migrated.prompts;
                draft.settled = migrated.settled;
            });
        }
        this.rows = migrated.prompts;
        this.settled = migrated.settled;
    }
    /** Record a delivered prompt ref (idempotent for one recipient key). */
    async record(conversationId, callId, key, ref, plan) {
        const state = await this.file.update((draft) => {
            const identity = `${conversationId}:${callId}:${key}`;
            const tombstone = draft.settled[identity];
            if (tombstone !== undefined) {
                // A settlement raced this record. An EMPTY ref never replaces
                // a delivered one; a REAL ref still installs while the row
                // survives so the late receipt can self-heal the edit. Once
                // the row is pruned, BOTH shapes are ignored — no resurrection.
                const existing = draft.prompts.find((row) => identityOf(row) === identity);
                if (existing === undefined)
                    return;
                if (ref.messageId === "")
                    return;
                if (existing.ref.messageId !== "")
                    return;
            }
            const existing = draft.prompts.find((row) => row.conversationId === conversationId && row.callId === callId && row.key === key);
            const next = { conversationId, callId, key, ref, plan };
            if (existing === undefined)
                draft.prompts.push(next);
            else
                draft.prompts[draft.prompts.indexOf(existing)] = next;
            prune(draft, this.now());
        });
        this.rows = state.prompts;
        this.settled = state.settled;
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
            .filter((row) => row.key === bindingKey && this.settled[identityOf(row)] === undefined)
            .map((row) => ({ conversationId: row.conversationId, callId: row.callId, plan: row.plan }));
    }
    /** Find the prompt behind a reply-to platform message id. */
    byReplyTo(bindingKey, messageId) {
        const row = this.rows.find((candidate) => candidate.key === bindingKey &&
            candidate.ref.messageId === messageId &&
            this.settled[identityOf(candidate)] === undefined);
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
    /** Retire pending answers; the refs stay until retention expires them. */
    async settle(conversationId, callId, outcome = "answered") {
        const state = await this.file.update((draft) => {
            const keys = draft.prompts
                .filter((row) => row.conversationId === conversationId && row.callId === callId)
                .map(identityOf);
            for (const identity of keys) {
                // Re-settling an already-settled interaction keeps the FIRST
                // settlement's timestamp and outcome: retention is measured
                // from settlement, never extended by later writes.
                if (draft.settled[identity] !== undefined)
                    continue;
                draft.settled[identity] = { at: this.now(), outcome };
            }
            prune(draft, this.now());
        });
        this.rows = state.prompts;
        this.settled = state.settled;
    }
    /**
     * The outcome text recorded at settlement, when this identity is
     * settled. The receipt path reads it to self-heal the prompt edit;
     * the tombstone outlives the bulky row, so the answer survives
     * pruning even when no editable ref remains.
     */
    settledOutcome(conversationId, callId, key) {
        return this.settled[`${conversationId}:${callId}:${key}`]?.outcome;
    }
}
/**
 * THE retention helper (init and every write call this, at most once
 * per write): a SETTLED row expires at `settledAt + RETENTION_MS <= now`.
 * The tombstone itself is never pruned — it is what stops a delayed
 * receipt from recreating an answerable prompt. Pending rows are
 * never age-pruned.
 */
function prune(draft, now) {
    draft.prompts = draft.prompts.filter((row) => {
        const tombstone = draft.settled[identityOf(row)];
        if (tombstone === undefined)
            return true;
        return tombstone.at + PROMPT_RETENTION_MS > now;
    });
}
/**
 * Normalize whatever was on disk to the v2 shape. An unversioned v1
 * file keeps every prompt row and stamps its settled identities with
 * the MIGRATION time (one cohort, expiring together seven days later).
 * Individually malformed tombstones are dropped with a log line each;
 * valid unrelated rows are never discarded. A wholly malformed JSON
 * document never reaches here — JsonFile throws naming the path.
 */
function migrate(state, now, log) {
    const prompts = Array.isArray(state.prompts) ? state.prompts : [];
    const settled = {};
    const raw = state.settled;
    if (Array.isArray(raw)) {
        // v1: bare identities, age unknown — the migration timestamp is
        // the conservative choice (one further retention window).
        for (const identity of raw) {
            if (typeof identity !== "string")
                continue;
            settled[identity] = { at: now, outcome: "answered" };
        }
    }
    else if (raw !== null && typeof raw === "object") {
        for (const [identity, value] of Object.entries(raw)) {
            const tombstone = value;
            if (tombstone === null || typeof tombstone !== "object" ||
                typeof tombstone.at !== "number" || !Number.isFinite(tombstone.at) ||
                typeof tombstone.outcome !== "string") {
                log?.warn(`prompts: dropping malformed settled tombstone "${identity}" (its row, if any, stays live)`);
                continue;
            }
            if (!validIdentity(identity)) {
                log?.warn(`prompts: dropping settled tombstone with a malformed identity "${identity}"`);
                continue;
            }
            settled[identity] = { at: tombstone.at, outcome: tombstone.outcome };
        }
    }
    else if (raw !== undefined) {
        log?.warn("prompts: ignoring malformed settled container (expected an array or map)");
    }
    return { version: PROMPT_FILE_VERSION, prompts, settled };
}
function identityOf(row) {
    return `${row.conversationId}:${row.callId}:${row.key}`;
}
/**
 * An identity is `<conversationId>:<callId>:<key>` — a positive integer
 * conversation id, a non-empty callId without colons, and a non-empty
 * key (opaque binding/home keys may themselves contain colons).
 */
function validIdentity(identity) {
    const separator = identity.indexOf(":");
    if (separator <= 0)
        return false;
    if (!/^[1-9][0-9]*$/.test(identity.slice(0, separator)))
        return false;
    const rest = identity.slice(separator + 1);
    const second = rest.indexOf(":");
    return second > 0 && second < rest.length - 1;
}
