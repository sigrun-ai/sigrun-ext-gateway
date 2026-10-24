/**
 * The `/pair` command (spec §8.2): the admin surface for pending
 * pairing requests, runnable from any webui/TUI conversation through
 * the extension-command invoke route (`POST /v1/conversations/:id/
 * commands/pair`) — and, through the same decision functions, from
 * chat via the pairing-notice buttons (§8.2: every admin's home DM
 * gets the request; the buttons carry opaque tokens the pipeline
 * resolves).
 *
 * Admin-only (EFFECTIVE admin — the caller's principal carries it from
 * the stored flag OR the persisted group grant, C8). An unnamed caller
 * (the no-auth loopback method) is refused with the pinned
 * "run this as a named user".
 *
 * `approve <code> <user>` links the REQUESTER (the platform sender who
 * asked to pair) to the named directory user via the identity store
 * (`via: "pairing"`), sets their DM as the home chat, and sends them a
 * "linked" message through their channel. A sender already linked to
 * another user is refused, never silently re-pointed — the request
 * stays pending for an admin to resolve (deny, or fix the link).
 */
import type { ChannelContribution } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
import type { IdentityStore } from "../state/identities.js";
import type { PairingStore } from "../access/pairing.js";
/** The `/pair` decision path's runtime dependencies (the engine wires them). */
export interface PairDeps {
    /** The host: the directory the approved user must exist in. */
    readonly host: {
        readonly users: {
            list(): Promise<readonly {
                readonly user: string;
            }[]>;
        };
    };
    readonly identities: IdentityStore;
    readonly pairing: PairingStore;
    /**
     * The channel adapter for `channelOf(id)` — the "linked" reply rides
     * the requester's own channel (undefined: the channel went away; the
     * reply is skipped, the link still lands).
     */
    readonly channelOf: (channel: string) => ChannelContribution | undefined;
    readonly log: EngineLog;
    readonly now: () => number;
}
/** Who invoked the command. */
export interface PairCaller {
    readonly user: string | undefined;
    readonly admin: boolean;
}
/** The pinned refusal for an unnamed caller (spec §8.2). */
export declare const UNNAMED_CALLER = "run this as a named user";
/** The pinned conflict reply (spec §8.2: never silently re-pointed). */
export declare const PAIR_CONFLICT_REPLY = "That sender is already linked to another user.";
/**
 * Run `/pair` with `args` as `caller`. Every path resolves a string
 * reply (the command's notice); nothing throws across the boundary.
 */
export declare function runPair(deps: PairDeps, args: string, caller: PairCaller): Promise<string>;
/**
 * Apply `deny <code>` (the command and the button share this path).
 * Returns the decision reply for the admin surface.
 */
export declare function denyPairing(deps: PairDeps, code: string): string;
/**
 * Apply `approve <code> <user>` (the command and the "Approve as"
 * buttons share this path): directory check, conflict check, then the
 * link + the requester's "linked" message. The conflict check runs
 * BEFORE the queue row is consumed so a refused approval leaves the
 * request pending.
 */
export declare function approvePairing(deps: PairDeps, code: string, namedUser: string): Promise<string>;
