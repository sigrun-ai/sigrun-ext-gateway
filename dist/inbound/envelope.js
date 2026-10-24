/**
 * The inbound envelope (spec §8.10): the text the model sees — the
 * group `[<label>]` prefix, the reply-quote block, and the DM
 * pass-through. The quote truncates at 500 chars (the plan's pinned
 * value) with a single ellipsis marker; the author line renders when
 * the platform names the replied-to author (a reply to the bot itself
 * carries no author name — the quote block alone keeps the thread
 * context).
 */
/** The reply-quote truncation cap (the plan's pinned 500 chars). */
const QUOTE_MAX = 500;
/**
 * Build the envelope text for one inbound event. `group` selects the
 * `[<senderLabel>]` prefix; the reply-quote block prefixes either form
 * when the event carries a `replyTo`.
 */
export function buildEnvelope(event, opts) {
    const body = opts.group
        ? `[${opts.senderLabel}] ${event.text}`
        : event.text;
    if (event.replyTo === undefined)
        return body;
    const parts = [];
    if (event.replyTo.text !== undefined) {
        parts.push(`> ${truncate(event.replyTo.text)}`);
    }
    if (event.replyTo.authorName !== undefined) {
        parts.push(`(replying to ${event.replyTo.authorName})`);
    }
    if (parts.length === 0)
        return body;
    return `${parts.join("\n")}\n\n${body}`;
}
/** The 500-char truncation with a bare ellipsis marker. */
function truncate(text) {
    return text.length <= QUOTE_MAX
        ? text
        : `${text.slice(0, QUOTE_MAX)}…`;
}
