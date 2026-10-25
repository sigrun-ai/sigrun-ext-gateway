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
 * A sender already linked to another user gets core's conflict refusal
 * and the pinned reply; the code is NOT consumed until the link lands,
 * so the user can remove the conflicting link and send the SAME code.
 */

import type { InboundEvent } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
import type { IdentityStore } from "../state/identities.js";
import type { LinkCodes } from "../access/link-codes.js";
import type { ChannelConfig, GatewayConfig } from "../config.js";
import { normalizeCode } from "../access/codes.js";
import { chatProviderOf } from "../state/identities.js";

/** The pinned refusal for an unnamed caller (spec §8.2). */
export const UNNAMED_CALLER = "run this as a named user";

/** The pinned conflict reply (the code stays live). */
export const LINK_CONFLICT_REPLY =
	"This chat account is already linked to another sigrun user. Remove that link under account links in sigrun, then send the code again.";

/** The pinned invalid-code reply. */
const INVALID_CODE_REPLY = "That code is not valid.";

/** The chat-side redeem dependencies (the engine wires them). */
export interface LinkDeps {
	readonly identities: IdentityStore;
	readonly linkCodes: LinkCodes;
	readonly log: EngineLog;
	readonly now: () => number;
}

/**
 * Handle `/link <code>` from a DM: redeem, link, and return the reply
 * text (the pipeline sends it). Core owns the conflict check; the
 * static allowlist never blocks a self-link (it shadows the link
 * afterward, exactly as any stale link).
 */
export async function redeemLink(
	deps: LinkDeps,
	channel: string,
	event: InboundEvent,
): Promise<string> {
	const code = normalizeCode(event.text.replace(/^\/link\s*/, ""));
	const now = deps.now();
	const user = deps.linkCodes.peek(code, channel, now);
	if (user === undefined) return INVALID_CODE_REPLY;
	const linked = await deps.identities.link(channel, event.sender.id, user, "self", event.chat);
	if (!linked.linked) return LINK_CONFLICT_REPLY;
	// Redeem only after the link succeeds: a conflict keeps the code live.
	const redeemed = deps.linkCodes.redeem(code, channel, now);
	if (redeemed === undefined) {
		deps.log.warn(
			`self-link for user "${user}" on provider "${chatProviderOf(channel)}" is durable but code redemption failed`,
		);
		return INVALID_CODE_REPLY;
	}
	deps.log.info(`self-link landed on channel "${channel}" for user "${redeemed}"`);
	return `You are linked to sigrun as ${redeemed}.`;
}

/** The `/link <channel>` webui/TUI command's dependencies. */
export interface LinkCommandDeps {
	/** The live config read (channel enablement is per-read). */
	readonly readConfig: () => Promise<GatewayConfig>;
	readonly linkCodes: LinkCodes;
	/** The channel ids the engine recorded at start (unknown-channel refusal). */
	readonly knownChannels: () => readonly string[];
	readonly now: () => number;
}

/** The command contribution shape (the loader validates name/run). */
export interface LinkCommand {
	readonly name: string;
	readonly description: string;
	readonly args: string;
	run(ctx: {
		readonly principal: { readonly user: string | undefined };
		readonly args: string;
	}): Promise<{ readonly notice: string }>;
}

/** Build the `link` slash command over the engine's shared state. */
export function createLinkCommand(deps: LinkCommandDeps): LinkCommand {
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
			const block: ChannelConfig | { readonly failed: string } | undefined =
				config.channels[channel];
			if (block === undefined || "failed" in block || !block.enabled) {
				return { notice: `channel ${channel} is disabled.` };
			}
			const code = deps.linkCodes.issue(ctx.principal.user, channel, deps.now());
			return {
				notice:
					`Link code ${code}. Send "/link ${code}" to the bot in a direct ` +
					`message on ${channel} to finish linking.`,
			};
		},
	};
}
