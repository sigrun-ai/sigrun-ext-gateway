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
