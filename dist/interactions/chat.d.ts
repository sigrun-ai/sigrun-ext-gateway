/**
 * Interaction notification and settlement fan-out. Handlers only enqueue
 * durable ledger entries; delivery receipts populate PromptStore refs so
 * settlement can edit the exact platform messages.
 */
import type { ChannelContribution, ExtensionLifecyclePayload, HandlerContext, NotifierContribution } from "@sigrun/sigrun/extension";
import type { Ledger } from "../state/ledger.js";
import type { ButtonTokens } from "../inbound/tokens.js";
import type { EngineLog } from "../log.js";
import { type AnswerDeps } from "./answer.js";
export interface InteractionChatDeps extends AnswerDeps {
    readonly ledger: Ledger;
    readonly tokens: ButtonTokens;
    readonly channelOf: (channel: string) => ChannelContribution | undefined;
    readonly log: EngineLog;
}
/** The gateway notifier: interaction.pending plus the ordinary home notifier. */
export declare function createInteractionNotifier(deps: InteractionChatDeps): NotifierContribution;
/** Enqueue outcome edits/notices and retire numbered/reply-to matching. */
export declare function onInteractionSettled(event: ExtensionLifecyclePayload["interactionSettled"], deps: InteractionChatDeps, context: HandlerContext): Promise<void>;
/**
 * Enqueue settlement edits and per-binding fallback outcome notices
 * (a binding without an editable ref gets a notice). Called at settlement AND from the receipt
 * path when a real delivery ref arrives for an ALREADY-settled prompt:
 * settlement that beats the receipt leaves no editable ref, so the
 * late receipt is the last chance to replace the live buttons.
 */
export declare function enqueueSettlementEdits(deps: InteractionChatDeps, conversationId: number, callId: string, outcome: string): Promise<void>;
