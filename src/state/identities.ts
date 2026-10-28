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
import { JsonFile } from "./json-file.js";

/** How a chat link came to be. */
export type LinkVia = "pairing" | "self";

/** Core's one provider-key convention for platform senders. */
export function chatProviderOf(channel: string): string {
	return `chat:${channel}`;
}

/**
 * Core admits only this channel-id shape inside a chat provider. This
 * matches the loader's grammar exactly: every binding-key and target
 * parse splits on ":", so a wider alphabet would mis-attribute chats.
 */
export const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** One stored home chat row (per user, per channel). */
interface HomeRow {
	readonly chat: ChatRef;
}

/** The persisted shape of `identities.json`. */
interface IdentitiesFile {
	/** Legacy data is dropped on write, never read for resolution. */
	links?: Record<string, unknown>;
	/** `user` → `channel` → the home chat. */
	readonly homes: Record<string, Record<string, HomeRow>>;
}

/** The result of a `userFor` resolution. */
export interface ResolvedUser {
	readonly user: string;
	/** Whether the allowlist (not a link) produced the user. */
	readonly via: "allow" | "link";
}

/** The result of a core-backed link attempt. */
export type LinkResult =
	| { readonly linked: true }
	| { readonly linked: false; readonly reason: "conflict" };

/** Core-backed sender resolution and engine-owned home-chat persistence. */
export class IdentityStore {
	private readonly file: JsonFile<IdentitiesFile>;
	private homes: Record<string, Record<string, HomeRow>> = {};

	constructor(
		private readonly host: SigrunHost,
		path: string,
		opts: { readonly log?: EngineLog } = {},
	) {
		this.file = new JsonFile<IdentitiesFile>(path, () => ({ homes: {} }));
		// Home reads are synchronous by contract; load the mirror before
		// admitting work, as the other engine-owned JsonFile stores do.
		const state = this.file.readSync();
		this.homes = state.homes;
		const legacyCount = Object.keys(state.links ?? {}).length;
		if (legacyCount > 0) {
			opts.log?.warn(
				`identities.json contains ${legacyCount} legacy links; those senders must pair or self-link again`,
			);
		}
	}

	/** Resolve the allowlist first; only an unlisted sender reads core. */
	async userFor(
		config: ChannelConfig,
		channel: string,
		senderId: string,
	): Promise<ResolvedUser | undefined> {
		const allowed = config.allow.find(
			(entry) => entry.sender === senderId,
		)?.user;
		if (allowed !== undefined) return { user: allowed, via: "allow" };
		const linked = await this.host.accounts.lookup(chatProviderOf(channel), senderId);
		return linked === undefined ? undefined : { user: linked.user, via: "link" };
	}

	/** Link through core; only core's conflict refusal maps to a result. */
	async link(
		channel: string,
		senderId: string,
		user: string,
		via: LinkVia,
		dmChat: ChatRef,
	): Promise<LinkResult> {
		try {
			await this.host.accounts.link(chatProviderOf(channel), senderId, user, via);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("account_link_conflict:")
			) {
				return { linked: false, reason: "conflict" };
			}
			throw error;
		}
		try {
			await this.file.update((draft) => {
				delete draft.links;
				// First link sets the home chat (a later /home moves it).
				if (draft.homes[user]?.[channel] === undefined) {
					const perChannel = draft.homes[user] ?? {};
					perChannel[channel] = { chat: dmChat };
					draft.homes[user] = perChannel;
				}
			}).then((state) => this.reload(state));
		} catch (error) {
			// Core has already durably linked the sender. Preserve this
			// absent home in memory before rethrowing so homesOf and a
			// same-user retry do not pretend the first link never happened;
			// the next successful write persists it.
			this.rememberHome(user, channel, dmChat);
			throw error;
		}
		return { linked: true };
	}

	/** Core removes links before userDeleted; the engine clears homes only. */
	async forgetHomes(user: string): Promise<void> {
		await this.file.update((draft) => {
			delete draft.links;
			delete draft.homes[user];
		}).then((state) => this.reload(state));
	}

	/** The user's home chats, one per channel. */
	homesOf(user: string): readonly { channel: string; chat: ChatRef }[] {
		const perChannel = this.homes[user];
		if (perChannel === undefined) return [];
		return Object.entries(perChannel).map(([channel, row]) => ({
			channel,
			chat: row.chat,
		}));
	}

	/** Install an absent home without an await before the mirror update,
	 * preserving admission order. The durable write is queued behind the
	 * synchronous in-memory update; the caller owns its completion/error. */
	ensureHome(user: string, channel: string, chat: ChatRef): Promise<void> {
		if (this.homes[user]?.[channel] !== undefined) return Promise.resolve();
		const perChannel = this.homes[user] ?? {};
		perChannel[channel] = { chat };
		this.homes[user] = perChannel;
		return this.file.update((draft) => {
			delete draft.links;
			if (draft.homes[user]?.[channel] !== undefined) return;
			const stored = draft.homes[user] ?? {};
			stored[channel] = { chat };
			draft.homes[user] = stored;
		}).then(() => undefined);
	}

	/** Set (move) the user's home chat on `channel`. */
	async setHome(user: string, channel: string, chat: ChatRef): Promise<void> {
		await this.file.update((draft) => {
			delete draft.links;
			const perChannel = draft.homes[user] ?? {};
			perChannel[channel] = { chat };
			draft.homes[user] = perChannel;
		}).then((state) => this.reload(state));
	}

	/** Refresh the home mirror from the written state (post-mutation). */
	private reload(state: IdentitiesFile): void {
		this.homes = state.homes;
	}

	/** Preserve an absent home without touching its durable file. */
	private rememberHome(user: string, channel: string, chat: ChatRef): void {
		if (this.homes[user]?.[channel] !== undefined) return;
		const perChannel = this.homes[user] ?? {};
		perChannel[channel] = { chat };
		this.homes[user] = perChannel;
	}
}
