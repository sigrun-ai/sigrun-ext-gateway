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
/** The pinned expiry (ms). */
export declare const PAIRING_TTL_MS = 3600000;
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
/** The request outcome: the code, or which limit applied. */
export type RequestResult = {
    readonly code: string;
} | {
    readonly limited: "sender" | "cooldown" | "channel";
};
/**
 * The pairing queue, one instance per engine. The public API is
 * SYNCHRONOUS by interface (the pipeline's step 5 answers inline), so
 * every mutation writes the file through JsonFile's SYNCHRONOUS
 * update — a crash between the verdict and a deferred flush would
 * silently lose a pending request (the operator's queue).
 */
export declare class PairingStore {
    private readonly file;
    private readonly now;
    private mirror;
    constructor(path: string, opts?: {
        readonly now?: () => number;
    });
    /**
     * Create (or refuse) a pairing request. The caller hands `now` so the
     * pipeline can pin a clock in tests; the store's own clock seeds the
     * cooldown record.
     */
    request(channel: string, sender: {
        id: string;
        name?: string;
    }, chat: ChatRef, now: number): RequestResult;
    /** The live pending rows, optionally filtered to one channel. */
    pending(channel?: string): readonly PairingRequest[];
    /** Approve by code: the request leaves the queue and returns. */
    approve(code: string, now?: number): PairingRequest | undefined;
    /** Deny by code: true when a live request was removed. */
    deny(code: string): boolean;
    /** The expired-row sweep: expired requests count against no limit. */
    private livePending;
    /**
     * Persist the mirror: the SYNCHRONOUS atomic write (see the class
     * doc). A failed persist is loud, never swallowed — the verdict
     * already returned to the pipeline, but the operator must see the
     * file diverged (the JsonFile throw names the path).
     */
    private persist;
}
