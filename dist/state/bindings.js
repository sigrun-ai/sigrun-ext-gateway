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
    }
    /** The live binding for `key`, or undefined when unbound. */
    get(key) {
        // Read the file synchronously per call. ONE instance is threaded
        // engine-wide now, so a construction-time mirror COULD suffice — but
        // the reads are cheap local JSON and the per-call read keeps the
        // store honest against EXTERNAL writers (a crash-recovery e2e or an
        // operator repairing bindings.json between calls) and against any
        // future second instance. The mirror was REMOVED precisely because
        // it went stale across instances; readSync is the fix that stays.
        return toBinding(this.file.readSync().bindings[key]);
    }
    /** One file read's binding rows, keyed for target authorization. */
    entries() {
        return Object.fromEntries(Object.entries(this.file.readSync().bindings).map(([key, row]) => [
            key,
            toBinding(row),
        ]));
    }
    /** Every live binding key (target authorization and chat enumeration). */
    allKeys() {
        return Object.keys(this.file.readSync().bindings);
    }
    /** Every live key bound to `conversationId` (the delivery fan-out read). */
    keysOf(conversationId) {
        const keys = [];
        for (const [key, row] of Object.entries(this.file.readSync().bindings)) {
            if (row.conversationId === conversationId)
                keys.push(key);
        }
        return keys;
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
        });
    }
    /** Remove the binding entirely (the access-revoked path). */
    async unbind(key) {
        await this.file.update((draft) => {
            delete draft.bindings[key];
        });
    }
    /** Mark the binding dead (`chat_gone` delivery): kept, never delivered to. */
    async markDead(key) {
        await this.file.update((draft) => {
            const row = draft.bindings[key];
            if (row === undefined)
                return;
            draft.bindings[key] = { ...row, dead: true };
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
        });
    }
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
