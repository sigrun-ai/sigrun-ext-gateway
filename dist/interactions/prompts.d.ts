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
import type { MessageRef } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
import type { ChatAnswerPlan } from "./render.js";
/** Settled-row retention (matches the delivery ledger's seven days). */
export declare const PROMPT_RETENTION_MS = 604800000;
export interface PendingPrompt {
    readonly conversationId: number;
    readonly callId: string;
    readonly plan: ChatAnswerPlan;
}
export interface PromptStoreOptions {
    readonly now?: () => number;
    readonly log?: EngineLog;
}
export declare class PromptStore {
    private readonly file;
    private readonly now;
    private readonly log;
    private rows;
    private settled;
    constructor(path: string, options?: PromptStoreOptions);
    /** Record a delivered prompt ref (idempotent for one recipient key). */
    record(conversationId: number, callId: string, key: string, ref: MessageRef, plan: ChatAnswerPlan): Promise<void>;
    /** All delivered message refs for settlement edits (including settled). */
    refsOf(conversationId: number, callId: string): readonly MessageRef[];
    /** Whether this recipient/chat already has a prompt recorded. */
    has(conversationId: number, callId: string, key: string): boolean;
    /** Recipient identities for opaque-key receipt correlation. */
    pendingRecipients(conversationId: number): readonly {
        callId: string;
        key: string;
    }[];
    /** Recipient keys for receipt correlation (opaque binding keys may contain colons). */
    keysOf(conversationId: number, callId: string): readonly string[];
    /** Unsettled choice/text prompts in one chat (bound key or user home key). */
    pendingInChat(bindingKey: string): readonly PendingPrompt[];
    /** Find the prompt behind a reply-to platform message id. */
    byReplyTo(bindingKey: string, messageId: string): PendingPrompt | undefined;
    /** A recipient has been enqueued even before its receipt supplies a ref. */
    markEnqueued(conversationId: number, callId: string, key: string, plan: ChatAnswerPlan): Promise<void>;
    /** Install the real refs after the interaction ledger entry is delivered. */
    recordReceipt(conversationId: number, callId: string, key: string, chat: MessageRef["chat"], messageIds: readonly string[]): Promise<void>;
    /** Retire pending answers; the refs stay until retention expires them. */
    settle(conversationId: number, callId: string, outcome?: string): Promise<void>;
    /**
     * The outcome text recorded at settlement, when this identity is
     * settled. The receipt path reads it to self-heal the prompt edit;
     * the tombstone outlives the bulky row, so the answer survives
     * pruning even when no editable ref remains.
     */
    settledOutcome(conversationId: number, callId: string, key: string): string | undefined;
}
