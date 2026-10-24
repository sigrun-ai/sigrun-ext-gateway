/**
 * The inbound envelope (spec §8.10): the text the model sees — the
 * group `[<label>]` prefix, the reply-quote block, and the DM
 * pass-through. The quote truncates at 500 chars (the plan's pinned
 * value) with a single ellipsis marker; the author line renders when
 * the platform names the replied-to author (a reply to the bot itself
 * carries no author name — the quote block alone keeps the thread
 * context).
 */
import type { InboundEvent } from "@sigrun/sigrun/extension";
/**
 * Build the envelope text for one inbound event. `group` selects the
 * `[<senderLabel>]` prefix; the reply-quote block prefixes either form
 * when the event carries a `replyTo`.
 */
export declare function buildEnvelope(event: InboundEvent, opts: {
    group: boolean;
    senderLabel: string;
}): string;
