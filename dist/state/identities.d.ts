/**
 * The identity store (spec §8.2): platform sender ids → sigrun users,
 * persisted at `<stateDir>/gateway/identities.json` in the ENGINE's own
 * state (never core's directory — the links are the gateway's to own).
 *
 * Resolution order for `userFor`: the channel's ALLOWLIST first, then a
 * stored link. When both exist and disagree, the allowlist wins and the
 * conflict is logged once per (channel, sender) — the operator pinned
 * the mapping deliberately, so a stale link must never shadow it. The
 * first link for a user also records their HOME chat for that channel
 * (§8.8: notifications target it); `/home` moves it later.
 */
import type { ChatRef } from "@sigrun/sigrun/extension";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
/** How a link came to be (pairing approval vs self-link). */
export type LinkVia = "pairing" | "self";
/** The result of a `userFor` resolution. */
export interface ResolvedUser {
    readonly user: string;
    /** Whether the allowlist (not a link) produced the user. */
    readonly via: "allow" | "link";
}
/**
 * The sender → user resolution, one instance per engine. All mutations
 * persist through the serialized JsonFile queue.
 */
export declare class IdentityStore {
    private readonly file;
    private readonly log;
    private readonly conflictLogged;
    constructor(path: string, opts?: {
        readonly log?: EngineLog;
    });
    /**
     * Resolve `senderId` on `channel` against `config`: the allowlist
     * wins over a link; undefined when the sender is unknown. A
     * conflicting (allow ≠ link) pair is logged once per sender.
     */
    userFor(config: ChannelConfig, channel: string, senderId: string): ResolvedUser | undefined;
    /** Link `senderId` on `channel` to `user`; the FIRST link also sets
     *  the user's home chat on that channel (§8.8). */
    link(channel: string, senderId: string, user: string, via: LinkVia, dmChat: ChatRef): Promise<void>;
    /**
     * The stored link's user for `senderId` on `channel` (the LINK alone,
     * never the allowlist): the pairing/self-link conflict guards read
     * this — a sender already linked to a DIFFERENT user must refuse,
     * never silently re-point (§8.2).
     */
    linkedUserOf(channel: string, senderId: string): string | undefined;
    /** Remove every link and home chat of `user` (the userDeleted path). */
    unlinkUser(user: string): Promise<void>;
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
    /**
     * The in-memory view (links + homes): loaded at construction
     * (readSync) and refreshed after every queued mutation — `userFor`
     * and `homesOf` are synchronous by contract.
     */
    private links;
    private homes;
    /** Refresh the in-memory view from the written state (post-mutation). */
    private reload;
}
