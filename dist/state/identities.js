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
import { JsonFile } from "./json-file.js";
/** The link key: `channel:senderId`. */
function linkKey(channel, senderId) {
    return `${channel}:${senderId}`;
}
/**
 * The sender → user resolution, one instance per engine. All mutations
 * persist through the serialized JsonFile queue.
 */
export class IdentityStore {
    file;
    log;
    conflictLogged = new Set();
    constructor(path, opts = {}) {
        this.file = new JsonFile(path, () => ({
            links: {},
            homes: {},
        }));
        this.log = opts.log;
        // The in-memory view loads SYNCHRONOUSLY at construction: a second
        // instance over the same file (the restart path) resolves links
        // from its first `userFor` — the constructor cannot await, and the
        // queue is empty here so nothing can interleave.
        const state = this.file.readSync();
        this.links = state.links;
        this.homes = state.homes;
    }
    /**
     * Resolve `senderId` on `channel` against `config`: the allowlist
     * wins over a link; undefined when the sender is unknown. A
     * conflicting (allow ≠ link) pair is logged once per sender.
     */
    userFor(config, channel, senderId) {
        const allowed = config.allow.find((entry) => entry.sender === senderId)?.user;
        const linked = this.links[linkKey(channel, senderId)]?.user;
        if (allowed !== undefined) {
            if (linked !== undefined && linked !== allowed) {
                this.log?.once(`identity-conflict:${channel}:${senderId}`, "warn", `allowlist user "${allowed}" shadows linked user "${linked}" for channel "${channel}"`);
            }
            return { user: allowed, via: "allow" };
        }
        if (linked !== undefined)
            return { user: linked, via: "link" };
        return undefined;
    }
    /** Link `senderId` on `channel` to `user`; the FIRST link also sets
     *  the user's home chat on that channel (§8.8). */
    async link(channel, senderId, user, via, dmChat) {
        await this.file.update((draft) => {
            draft.links[linkKey(channel, senderId)] = { user, via };
            // First link sets the home chat (a later /home moves it).
            if (draft.homes[user]?.[channel] === undefined) {
                const perChannel = draft.homes[user] ?? {};
                perChannel[channel] = { chat: dmChat };
                draft.homes[user] = perChannel;
            }
        }).then((state) => this.reload(state));
    }
    /** Remove every link and home chat of `user` (the userDeleted path). */
    async unlinkUser(user) {
        await this.file.update((draft) => {
            for (const [key, row] of Object.entries(draft.links)) {
                if (row.user === user)
                    delete draft.links[key];
            }
            delete draft.homes[user];
        }).then((state) => this.reload(state));
    }
    /** The user's home chats, one per channel. */
    homesOf(user) {
        const perChannel = this.homes[user];
        if (perChannel === undefined)
            return [];
        return Object.entries(perChannel).map(([channel, row]) => ({
            channel,
            chat: row.chat,
        }));
    }
    /** Set (move) the user's home chat on `channel`. */
    async setHome(user, channel, chat) {
        await this.file.update((draft) => {
            const perChannel = draft.homes[user] ?? {};
            perChannel[channel] = { chat };
            draft.homes[user] = perChannel;
        }).then((state) => this.reload(state));
    }
    /**
     * The in-memory view (links + homes): loaded at construction
     * (readSync) and refreshed after every queued mutation — `userFor`
     * and `homesOf` are synchronous by contract.
     */
    links = {};
    homes = {};
    /** Refresh the in-memory view from the written state (post-mutation). */
    reload(state) {
        this.links = state.links;
        this.homes = state.homes;
    }
}
