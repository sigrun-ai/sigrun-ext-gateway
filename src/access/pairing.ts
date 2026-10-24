/**
 * The pairing store (spec §8.2): pending pairing requests persisted at
 * `<stateDir>/gateway/pairing.json`.
 *
 * Pinned limits (the Hermes/OpenClaw shared parameters):
 * - at most 1 pending request per sender (`limited: "sender"`);
 * - at most 1 new request per sender per 600000 ms (`limited:
 *   "cooldown"` — enforced even after the previous request left the
 *   queue, so a spamming sender gets exactly one reply per window);
 * - at most 3 pending per channel (`limited: "channel"` — a visible
 *   DoS floor an admin clears through `/pair deny` and the status
 *   route).
 *
 * Codes expire after 3600000 ms; expired entries are dropped on every
 * read. Codes are never logged.
 */

import type { ChatRef } from "@sigrun/sigrun/extension";
import { JsonFile } from "../state/json-file.js";
import { newCode } from "./codes.js";

/** The pinned expiry (ms). */
export const PAIRING_TTL_MS = 3_600_000;

/** The pinned per-sender request cooldown (ms). */
const REQUEST_COOLDOWN_MS = 600_000;

/** The pinned per-sender pending cap. */
const SENDER_PENDING_MAX = 1;

/** The pinned per-channel pending cap. */
const CHANNEL_PENDING_MAX = 3;

/** One pending pairing request. */
export interface PairingRequest {
	readonly code: string;
	readonly channel: string;
	readonly senderId: string;
	readonly senderName?: string;
	/** The requester's DM — the approval's "linked" reply routes here. */
	readonly chat: ChatRef;
	readonly createdAt: number;
}

/** The persisted row (the wire form of {@link PairingRequest}). */
interface StoredRequest {
	code: string;
	channel: string;
	senderId: string;
	senderName?: string;
	chat: ChatRef;
	createdAt: number;
}

/** The persisted shape of `pairing.json`. */
interface PairingFile {
	pending: StoredRequest[];
	/** `channel:senderId` → the last request time (the cooldown clock). */
	lastRequest: Record<string, number>;
}

/** The request outcome: the code, or which limit applied. */
export type RequestResult =
	| { readonly code: string }
	| { readonly limited: "sender" | "cooldown" | "channel" };

/** The cooldown key: one clock per (channel, sender). */
function cooldownKey(channel: string, senderId: string): string {
	return `${channel}:${senderId}`;
}

/**
 * The pairing queue, one instance per engine. The public API is
 * SYNCHRONOUS by interface (the pipeline's step 5 answers inline), so
 * every mutation writes the file through JsonFile's SYNCHRONOUS
 * update — a crash between the verdict and a deferred flush would
 * silently lose a pending request (the operator's queue).
 */
export class PairingStore {
	private readonly file: JsonFile<PairingFile>;
	private readonly now: () => number;
	private mirror: PairingFile = { pending: [], lastRequest: {} };

	constructor(path: string, opts: { readonly now?: () => number } = {}) {
		this.file = new JsonFile<PairingFile>(path, () => ({
			pending: [],
			lastRequest: {},
		}));
		this.now = opts.now ?? Date.now;
		// The synchronous load: the constructor cannot await, and the queue
		// is empty here so nothing can interleave the first observation.
		this.mirror = this.file.readSync();
	}

	/**
	 * Create (or refuse) a pairing request. The caller hands `now` so the
	 * pipeline can pin a clock in tests; the store's own clock seeds the
	 * cooldown record.
	 */
	request(
		channel: string,
		sender: { id: string; name?: string },
		chat: ChatRef,
		now: number,
	): RequestResult {
		const live = this.livePending(now);
		if (
			live.some(
				(row) =>
					row.channel === channel && row.senderId === sender.id,
			)
		) {
			return { limited: "sender" };
		}
		const last = this.mirror.lastRequest[cooldownKey(channel, sender.id)];
		if (last !== undefined && now - last < REQUEST_COOLDOWN_MS) {
			return { limited: "cooldown" };
		}
		if (live.filter((row) => row.channel === channel).length >= CHANNEL_PENDING_MAX) {
			return { limited: "channel" };
		}
		const row: StoredRequest = {
			code: newCode(),
			channel,
			senderId: sender.id,
			...(sender.name === undefined ? {} : { senderName: sender.name }),
			chat,
			createdAt: now,
		};
		this.mirror = {
			pending: [...live, row],
			lastRequest: {
				...this.mirror.lastRequest,
				[cooldownKey(channel, sender.id)]: now,
			},
		};
		this.persist();
		return { code: row.code };
	}

	/** The live pending rows, optionally filtered to one channel. */
	pending(channel?: string): readonly PairingRequest[] {
		return this.livePending(this.now()).filter(
			(row) => channel === undefined || row.channel === channel,
		);
	}

	/** Approve by code: the request leaves the queue and returns. */
	approve(code: string, now: number = this.now()): PairingRequest | undefined {
		const row = this.livePending(now).find((entry) => entry.code === code);
		if (row === undefined) return undefined;
		this.mirror = {
			...this.mirror,
			pending: this.livePending(now).filter((entry) => entry.code !== code),
		};
		this.persist();
		return row;
	}

	/** Deny by code: true when a live request was removed. */
	deny(code: string): boolean {
		const row = this.livePending(this.now()).find((entry) => entry.code === code);
		if (row === undefined) return false;
		this.mirror = {
			...this.mirror,
			pending: this.livePending(this.now()).filter((entry) => entry.code !== code),
		};
		this.persist();
		return true;
	}

	/** The expired-row sweep: expired requests count against no limit. */
	private livePending(now: number): readonly StoredRequest[] {
		return this.mirror.pending.filter(
			(row) => now - row.createdAt < PAIRING_TTL_MS,
		);
	}

	/**
	 * Persist the mirror: the SYNCHRONOUS atomic write (see the class
	 * doc). A failed persist is loud, never swallowed — the verdict
	 * already returned to the pipeline, but the operator must see the
	 * file diverged (the JsonFile throw names the path).
	 */
	private persist(): void {
		this.mirror = this.file.updateSync((draft) => {
			draft.pending = this.mirror.pending;
			draft.lastRequest = this.mirror.lastRequest;
		});
	}
}
