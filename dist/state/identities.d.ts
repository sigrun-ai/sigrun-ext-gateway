/**
 * Sender identity resolution (spec §8.2): core owns the link table;
 * this store owns only per-user home chats in `identities.json`.
 *
 * Resolution order for `userFor`: the channel's ALLOWLIST first, then
 * `host.accounts.lookup("chat:<channel>", senderId)`. An allowlist hit
 * deliberately performs no core lookup: it is the operator's pinned
 * mapping, and any disagreeing core link remains inert.
 */
import type { ChatRef, SigrunHost } from "@sigrun/sigrun/extension";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
/** How a chat link came to be. */
export type LinkVia = "pairing" | "self";
/** Core's one provider-key convention for platform senders. */
export declare function chatProviderOf(channel: string): string;
/** Core admits only this channel-id shape inside a chat provider. */
export declare const CHANNEL_ID_PATTERN: RegExp;
/** The result of a `userFor` resolution. */
export interface ResolvedUser {
    readonly user: string;
    /** Whether the allowlist (not a link) produced the user. */
    readonly via: "allow" | "link";
}
/** The result of a core-backed link attempt. */
export type LinkResult = {
    readonly linked: true;
} | {
    readonly linked: false;
    readonly reason: "conflict";
};
/** Core-backed sender resolution and engine-owned home-chat persistence. */
export declare class IdentityStore {
    private readonly host;
    private readonly file;
    private homes;
    constructor(host: SigrunHost, path: string, opts?: {
        readonly log?: EngineLog;
    });
    /** Resolve the allowlist first; only an unlisted sender reads core. */
    userFor(config: ChannelConfig, channel: string, senderId: string): Promise<ResolvedUser | undefined>;
    /** Link through core; only core's conflict refusal maps to a result. */
    link(channel: string, senderId: string, user: string, via: LinkVia, dmChat: ChatRef): Promise<LinkResult>;
    /** Core removes links before userDeleted; the engine clears homes only. */
    forgetHomes(user: string): Promise<void>;
    /** The user's home chats, one per channel. */
    homesOf(user: string): readonly {
        channel: string;
        chat: ChatRef;
    }[];
    /** Install an absent home without an await before the mirror update,
     * preserving admission order. The durable write is queued behind the
     * synchronous in-memory update; the caller owns its completion/error. */
    ensureHome(user: string, channel: string, chat: ChatRef): Promise<void>;
    /** Set (move) the user's home chat on `channel`. */
    setHome(user: string, channel: string, chat: ChatRef): Promise<void>;
    /** Refresh the home mirror from the written state (post-mutation). */
    private reload;
    /** Preserve an absent home without touching its durable file. */
    private rememberHome;
}
