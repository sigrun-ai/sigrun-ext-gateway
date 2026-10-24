/**
 * The binding store (spec §8.3): one row per chat, key → the
 * conversation the chat is bound to. Persisted at
 * `<stateDir>/gateway/bindings.json` through {@link JsonFile} (0600,
 * atomic, serialized updates).
 *
 * `account` is always `default` in v1 (the multi-account slot the key
 * reserves so keys never need migrating); a thread rides its own key
 * segment. `previous` records every conversation the chat was bound to
 * before the current one (`/new` and rebinds append) — the outbound
 * side never reads it today, but `/status` (Task 7) shows it and the
 * array is the honest history a rebind loses otherwise.
 */
import { JsonFile } from "./json-file.js";
/** The binding key (§8.3): `<channel>:default:<chatType>:<chatId>[:threadId]`. */
export function bindingKey(channel, chat) {
    const base = `${channel}:default:${chat.chatType}:${chat.chatId}`;
    return chat.threadId === undefined
        ? base
        : `${base}:${chat.threadId}`;
}
/**
 * The chat → conversation bindings, one instance per engine. `bind` is
 * the only mutator that grows `previous`; every method persists through
 * the serialized JsonFile queue, so concurrent receives on the same
 * chat never lose a rebind.
 */
export class BindingStore {
    file;
    /** The write-side clock (tests inject a fake; default real). */
    now;
    constructor(path, opts = {}) {
        this.file = new JsonFile(path, () => ({
            bindings: {},
        }));
        this.now = opts.now ?? Date.now;
        // The mirror loads SYNCHRONOUSLY at construction: a second instance
        // over the same file (the restart path) must observe the persisted
        // bindings from its first `get` — the constructor cannot await.
        // The queue is empty at construction, so nothing can interleave.
        for (const [key, row] of Object.entries(this.file.readSync().bindings)) {
            this.mirror.set(key, row);
        }
    }
    /** The live binding for `key`, or undefined when unbound. */
    get(key) {
        // The in-memory draft is authoritative between writes (every
        // mutation re-reads the file inside its queue slot; a `get`
        // between queued writes must not observe a torn state, so the
        // store keeps its own synchronous mirror under the same queue).
        return this.mirror.get(key) === undefined
            ? this.mirror.get(key)
            : toBinding(this.mirror.get(key));
    }
    /** Bind `key` to `conversationId`, recording any prior binding in `previous`. */
    async bind(key, conversationId, chat) {
        await this.file.update((draft) => {
            const prior = draft.bindings[key];
            if (prior === undefined) {
                draft.bindings[key] = {
                    conversationId,
                    chat,
                    boundAt: this.now(),
                    previous: [],
                };
            }
            else {
                draft.bindings[key] = {
                    conversationId,
                    chat,
                    boundAt: this.now(),
                    previous: [
                        ...prior.previous.filter((id) => id !== conversationId),
                        prior.conversationId,
                    ],
                    ...(prior.dead === undefined ? {} : { dead: prior.dead }),
                };
            }
            this.mirror.set(key, draft.bindings[key]);
        });
    }
    /** Remove the binding entirely (the access-revoked path). */
    async unbind(key) {
        await this.file.update((draft) => {
            delete draft.bindings[key];
            this.mirror.delete(key);
        });
    }
    /** Every live key bound to `conversationId` (the delivery fan-out read). */
    keysOf(conversationId) {
        const keys = [];
        for (const [key, row] of this.mirror) {
            if (row.conversationId === conversationId)
                keys.push(key);
        }
        return keys;
    }
    /** Mark the binding dead (`chat_gone` delivery): kept, never delivered to. */
    async markDead(key) {
        await this.file.update((draft) => {
            const row = draft.bindings[key];
            if (row === undefined)
                return;
            draft.bindings[key] = { ...row, dead: true };
            this.mirror.set(key, draft.bindings[key]);
        });
    }
    /** Clear the dead flag (a new inbound event proves the chat alive). */
    async clearDead(key) {
        await this.file.update((draft) => {
            const row = draft.bindings[key];
            if (row === undefined || row.dead === undefined)
                return;
            const { dead: _dead, ...rest } = row;
            draft.bindings[key] = rest;
            this.mirror.set(key, rest);
        });
    }
    /**
     * The synchronous mirror of the file's bindings: loaded at
     * construction (readSync), refreshed inside every queued mutation.
     */
    mirror = new Map();
}
/** Narrow a stored row to the public binding shape. */
function toBinding(row) {
    if (row === undefined)
        return undefined;
    return {
        conversationId: row.conversationId,
        chat: row.chat,
        boundAt: row.boundAt,
        previous: [...row.previous],
        ...(row.dead === undefined ? {} : { dead: row.dead }),
    };
}
