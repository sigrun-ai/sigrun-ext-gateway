/**
 * Durable chat-prompt bookkeeping. Ledger delivery receipts become
 * MessageRefs here; pending reads stay synchronous for inbound stage 8.
 * Settled prompts stop matching numbered/reply-to answers; their refs
 * remain so settlement can edit the delivered platform message.
 */
import type { MessageRef } from "@sigrun/sigrun/extension";
import type { ChatAnswerPlan } from "./render.js";
export interface PendingPrompt {
    readonly conversationId: number;
    readonly callId: string;
    readonly plan: ChatAnswerPlan;
}
export declare class PromptStore {
    private readonly file;
    private rows;
    private settled;
    /** identity → outcome text, recorded at settlement (Phase B timestamps). */
    private readonly outcomes;
    constructor(path: string);
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
    /** Retire pending answers while preserving refs for the settlement edit. */
    settle(conversationId: number, callId: string, outcome?: string): Promise<void>;
    /**
     * The outcome text recorded at settlement, when this identity is
     * settled. The receipt path reads it to self-heal the prompt edit.
     */
    settledOutcome(conversationId: number, callId: string, key: string): string | undefined;
}
