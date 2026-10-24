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
import type { ChatRef } from "@sigrun/sigrun/extension";
/** One live binding: the chat → conversation edge. */
export interface Binding {
    readonly conversationId: number;
    readonly chat: ChatRef;
    /** Clock ms when the CURRENT conversation was bound. */
    readonly boundAt: number;
    /** Earlier conversation ids this chat was bound to, oldest first. */
    readonly previous: readonly number[];
    /** Set when delivery classified the chat gone (`chat_gone`). */
    readonly dead?: boolean;
}
/** The binding key (§8.3): `<channel>:default:<chatType>:<chatId>[:threadId]`. */
export declare function bindingKey(channel: string, chat: ChatRef): string;
/**
 * The chat → conversation bindings, one instance per engine. `bind` is
 * the only mutator that grows `previous`; every method persists through
 * the serialized JsonFile queue, so concurrent receives on the same
 * chat never lose a rebind.
 */
export declare class BindingStore {
    private readonly file;
    /** The write-side clock (tests inject a fake; default real). */
    private readonly now;
    constructor(path: string, opts?: {
        readonly now?: () => number;
    });
    /** The live binding for `key`, or undefined when unbound. */
    get(key: string): Binding | undefined;
    /** Every live binding key (target authorization and chat enumeration). */
    allKeys(): readonly string[];
    /** Every live key bound to `conversationId` (the delivery fan-out read). */
    keysOf(conversationId: number): readonly string[];
    /** Bind `key` to `conversationId`, recording any prior binding in `previous`. */
    bind(key: string, conversationId: number, chat: ChatRef): Promise<void>;
    /** Remove the binding entirely (the access-revoked path). */
    unbind(key: string): Promise<void>;
    /** Mark the binding dead (`chat_gone` delivery): kept, never delivered to. */
    markDead(key: string): Promise<void>;
    /** Clear the dead flag (a new inbound event proves the chat alive). */
    clearDead(key: string): Promise<void>;
}
