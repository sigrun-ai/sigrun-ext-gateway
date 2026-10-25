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
import type { GatewayConfig } from "../config.js";
/** The pinned refusal for an unnamed caller (spec §8.2). */
export declare const UNNAMED_CALLER = "run this as a named user";
/** The pinned conflict reply (the code stays live). */
export declare const LINK_CONFLICT_REPLY = "This chat account is already linked to another sigrun user. Remove that link under account links in sigrun, then send the code again.";
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
export declare function redeemLink(deps: LinkDeps, channel: string, event: InboundEvent): Promise<string>;
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
        readonly principal: {
            readonly user: string | undefined;
        };
        readonly args: string;
    }): Promise<{
        readonly notice: string;
    }>;
}
/** Build the `link` slash command over the engine's shared state. */
export declare function createLinkCommand(deps: LinkCommandDeps): LinkCommand;
