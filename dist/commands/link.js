/**
 * Self-linking (spec §8.2): the webui/TUI `/link <channel>` command
 * issues a single-use code bound to the invoking user and channel, and
 * the chat-side `redeemLink` (pipeline step 4) consumes it in a DM.
 *
 * Proof by holding both sessions: the code is the only bridge, so it is
 * single-use, channel-bound, expires with pairing codes (3600000 ms),
 * and a code exposed in a GROUP is invalidated (other members saw it —
 * M9; the group refusal lives in the pipeline step, which owns the
 * chat-shape check).
 *
 * A sender already linked to another user gets the pinned conflict
 * reply and the code is NOT consumed: the user fixes the conflicting
 * link in sigrun, then sends the SAME code again. The peek-then-redeem
 * ordering is what keeps the code live on conflict.
 */
import { normalizeCode } from "../access/codes.js";
/** The pinned refusal for an unnamed caller (spec §8.2). */
export const UNNAMED_CALLER = "run this as a named user";
/** The pinned conflict reply (the code stays live). */
export const LINK_CONFLICT_REPLY = "This chat account is already linked to another sigrun user. Remove that link under account links in sigrun, then send the code again.";
/** The pinned invalid-code reply. */
const INVALID_CODE_REPLY = "That code is not valid.";
/**
 * Handle `/link <code>` from a DM: redeem, link, and return the reply
 * text (the pipeline sends it). The conflict check reads the LINK
 * table alone (`linkedUserOf`): spec §8.2 pins the refusal to a sender
 * "already linked to another user" — the static allowlist is the
 * operator's deliberate precedence-1 pin and never blocks a self-link
 * (it shadows the link afterward, exactly as any stale link). Never
 * throws across the boundary.
 */
export async function redeemLink(deps, channel, event) {
    const code = normalizeCode(event.text.replace(/^\/link\s*/, ""));
    const now = deps.now();
    const user = deps.linkCodes.peek(code, channel, now);
    if (user === undefined)
        return INVALID_CODE_REPLY;
    const existing = deps.identities.linkedUserOf(channel, event.sender.id);
    if (existing !== undefined && existing !== user) {
        return LINK_CONFLICT_REPLY;
    }
    const redeemed = deps.linkCodes.redeem(code, channel, now);
    if (redeemed === undefined)
        return INVALID_CODE_REPLY;
    await deps.identities.link(channel, event.sender.id, redeemed, "self", event.chat);
    deps.log.info(`self-link landed on channel "${channel}" for user "${redeemed}"`);
    return `You are linked to sigrun as ${redeemed}.`;
}
/** Build the `link` slash command over the engine's shared state. */
export function createLinkCommand(deps) {
    return {
        name: "link",
        description: "Link this chat account to a channel with a single-use code",
        args: "<channel>",
        run: async (ctx) => {
            if (ctx.principal.user === undefined) {
                return { notice: UNNAMED_CALLER };
            }
            const channel = ctx.args.trim();
            if (channel === "") {
                return { notice: "usage: /link <channel>" };
            }
            if (!deps.knownChannels().includes(channel)) {
                return { notice: `unknown channel ${channel}.` };
            }
            const config = await deps.readConfig();
            const block = config.channels[channel];
            if (block === undefined || "failed" in block || !block.enabled) {
                return { notice: `channel ${channel} is disabled.` };
            }
            const code = deps.linkCodes.issue(ctx.principal.user, channel, deps.now());
            return {
                notice: `Link code ${code}. Send "/link ${code}" to the bot in a direct ` +
                    `message on ${channel} to finish linking.`,
            };
        },
    };
}
