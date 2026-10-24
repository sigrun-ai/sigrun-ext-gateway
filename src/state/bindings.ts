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
import { JsonFile } from "./json-file.js";

/** The persisted shape of `bindings.json`. */
interface BindingsFile {
	readonly bindings: Record<string, StoredBinding>;
}

/** One stored binding row (the persisted form of {@link Binding}). */
interface StoredBinding {
	readonly conversationId: number;
	readonly chat: ChatRef;
	readonly boundAt: number;
	readonly previous: number[];
	readonly dead?: boolean;
}

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
export function bindingKey(channel: string, chat: ChatRef): string {
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
	private readonly file: JsonFile<BindingsFile>;
	/** The write-side clock (tests inject a fake; default real). */
	private readonly now: () => number;

	constructor(
		path: string,
		opts: { readonly now?: () => number } = {},
	) {
		this.file = new JsonFile<BindingsFile>(path, () => ({
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
	get(key: string): Binding | undefined {
		// The synchronous mirror is authoritative (loaded at construction,
		// refreshed inside every queued mutation — see {@link mirror}).
		return toBinding(this.mirror.get(key));
	}

	/** Bind `key` to `conversationId`, recording any prior binding in `previous`. */
	async bind(
		key: string,
		conversationId: number,
		chat: ChatRef,
	): Promise<void> {
		await this.file.update((draft) => {
			const prior = draft.bindings[key];
			if (prior === undefined) {
				draft.bindings[key] = {
					conversationId,
					chat,
					boundAt: this.now(),
					previous: [],
				};
			} else {
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
	async unbind(key: string): Promise<void> {
		await this.file.update((draft) => {
			delete draft.bindings[key];
			this.mirror.delete(key);
		});
	}

	/** Every live key bound to `conversationId` (the delivery fan-out read). */
	keysOf(conversationId: number): readonly string[] {
		const keys: string[] = [];
		for (const [key, row] of this.mirror) {
			if (row.conversationId === conversationId) keys.push(key);
		}
		return keys;
	}

	/** Mark the binding dead (`chat_gone` delivery): kept, never delivered to. */
	async markDead(key: string): Promise<void> {
		await this.file.update((draft) => {
			const row = draft.bindings[key];
			if (row === undefined) return;
			draft.bindings[key] = { ...row, dead: true };
			this.mirror.set(key, draft.bindings[key]);
		});
	}

	/** Clear the dead flag (a new inbound event proves the chat alive). */
	async clearDead(key: string): Promise<void> {
		await this.file.update((draft) => {
			const row = draft.bindings[key];
			if (row === undefined || row.dead === undefined) return;
			const { dead: _dead, ...rest } = row;
			draft.bindings[key] = rest;
			this.mirror.set(key, rest);
		});
	}

	/**
	 * The synchronous mirror of the file's bindings: loaded at
	 * construction (readSync), refreshed inside every queued mutation.
	 */
	private readonly mirror = new Map<string, StoredBinding>();
}

/** Narrow a stored row to the public binding shape. */
function toBinding(row: StoredBinding | undefined): Binding | undefined {
	if (row === undefined) return undefined;
	return {
		conversationId: row.conversationId,
		chat: row.chat,
		boundAt: row.boundAt,
		previous: [...row.previous],
		...(row.dead === undefined ? {} : { dead: row.dead }),
	};
}
