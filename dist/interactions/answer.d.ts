/**
 * Write-gated answers originating in chat. Identity resolution belongs
 * to the pipeline/tap caller; this module independently re-checks
 * conversation write access immediately before answering.
 */
import type { JsonValue } from "@sigrun/shared/blocks";
import type { HandlerContext, InboundEvent, SigrunHost } from "@sigrun/sigrun/extension";
import { type BindingStore } from "../state/bindings.js";
import type { IdentityStore } from "../state/identities.js";
import type { PromptStore } from "./prompts.js";
export interface AnswerDeps {
    readonly host: SigrunHost;
    readonly bindings: BindingStore;
    readonly identities: IdentityStore;
    readonly prompts: PromptStore;
    readonly context?: HandlerContext;
    /** Direct adapter reply (the pipeline supplies it; unit callers need not). */
    readonly reply?: (event: InboundEvent, text: string) => Promise<void>;
}
export interface ChatAnswer {
    readonly conversationId: number;
    readonly callId: string;
    readonly values: Record<string, JsonValue>;
    readonly user: string | undefined;
}
/** Answer after proving the named chat user can still write the conversation. */
export declare function answerFromChat(deps: AnswerDeps, answer: ChatAnswer): Promise<string>;
/** One shared human-readable outcome for settlement edits and stale taps. */
export declare function outcomeOf(record: {
    readonly status: string;
    readonly answer?: {
        readonly values: Readonly<Record<string, JsonValue>>;
    };
    readonly answeredByUser?: string;
}): string;
/** Stage 8: consume a numbered or reply-to answer, else continue admission. */
export declare function createInteractionAnswerStage(deps: AnswerDeps & {
    readonly configOf?: (channel: string) => Promise<import("../config.js").ChannelConfig | undefined>;
}): (channelId: string, event: InboundEvent) => Promise<{
    outcome: "command";
} | undefined>;
