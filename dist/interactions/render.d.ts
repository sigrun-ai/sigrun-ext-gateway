/**
 * Deterministic chat presentation for a generic interaction record.
 * The planner admits only answers chat can represent faithfully; every
 * other root form stays in the webui (notably secrets and open choices).
 */
import { type ChoiceOption } from "@sigrun/shared/blocks";
import type { InteractionRecord } from "@sigrun/shared/interactions";
import type { ChannelCapabilities, OutboundMessage } from "@sigrun/sigrun/extension";
import type { TokenAction } from "../inbound/tokens.js";
/** The answer shapes a chat can collect without losing form semantics. */
export type ChatAnswerPlan = {
    readonly kind: "choice";
    readonly field: string;
    readonly options: readonly ChoiceOption[];
    readonly buttons: boolean;
} | {
    readonly kind: "text";
    readonly field: string;
} | {
    readonly kind: "webui";
};
export interface RenderInteractionOptions {
    readonly conversationName: string;
    readonly link?: string;
    /** The conversation stamped into each interaction token. */
    readonly conversationId?: number;
    /** Mint the opaque transport-private action carried by each button. */
    readonly issue: (action: TokenAction & {
        readonly kind: "interaction";
    }) => string;
}
/** Plan the one answer mechanism the record's root form supports in chat. */
export declare function planInteraction(record: InteractionRecord, caps: ChannelCapabilities): ChatAnswerPlan;
/** Render the generic record and its chat-specific answer affordance. */
export declare function renderInteraction(record: InteractionRecord, caps: ChannelCapabilities, opts: RenderInteractionOptions): {
    text: string;
    buttons?: OutboundMessage["buttons"];
};
export declare function truncateInteractionText(text: string, max: number): string;
