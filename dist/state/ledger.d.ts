/**
 * The durable delivery ledger (spec §8.6): every outbound send's state
 * machine — `pending` → `attempting` → `delivered` (receipt) or
 * `failed` — persisted at `<stateDir>/gateway/ledger.json` through
 * {@link JsonFile} (0600, atomic, serialized updates).
 *
 * File bytes are NEVER ledgered: an entry whose message carries `files`
 * stores a WORKSPACE PATH + conversation id instead, and the delivery
 * worker re-reads the bytes through `host.conversations.readFile` at
 * send time (the brief's rule — `files` bytes would bloat the ledger
 * and pin upload bytes into engine state).
 *
 * Restart recovery: `pending` entries are sent as-is; `attempting`
 * entries become `pending` with the `recovered` flag (the platform may
 * already hold them — the worker prefixes the marker). Tag dedupe:
 * enqueueing a tag that already exists returns undefined (the
 * re-delivery no-op).
 */
import type { ChatRef, MessageRef, OutboundMessage, SigrunHost } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
/** The persisted (JSON-safe) outbound message: `files` become a path. */
export interface SerializedOutbound {
    readonly chat: ChatRef;
    readonly text: string;
    readonly replyTo?: string;
    readonly buttons?: OutboundMessage["buttons"];
    /**
     * The workspace path + conversation id of each file (the send-time
     * re-read's `readFile` arguments) — never the bytes.
     */
    readonly files?: readonly {
        readonly conversationId: number;
        readonly path: string;
        readonly name: string;
        readonly mime?: string;
    }[];
}
/** One ledger row's lifecycle. */
export type LedgerState = "pending" | "attempting" | "delivered" | "failed";
/** What the entry is for (the worker's send-shape discrimination). */
export type LedgerKind = "final" | "notice" | "interaction" | "edit";
/**
 * One ledger entry. `tag` is the dedupe key (e.g.
 * `final:<conversationId>:<answerEntryId>:<bindingKey>`) — a replayed
 * settle (the platform redelivered, a restart re-ran a handler)
 * enqueues nothing.
 */
export interface LedgerEntry {
    readonly id: string;
    /** The channel id (the per-channel worker's queue key). */
    readonly channel: string;
    /** The binding key the entry rides (dead-marking on chat_gone). */
    readonly bindingKey?: string;
    readonly chat: ChatRef;
    readonly kind: LedgerKind;
    readonly message: SerializedOutbound;
    /** The edit target (kind "edit" only). */
    readonly ref?: MessageRef;
    readonly state: LedgerState;
    readonly attempts: number;
    readonly createdAt: number;
    /** When the entry entered its CURRENT state (clock ms) — the failure
     *  window reads THIS, never `createdAt`: an old entry failing NOW is
     *  a fresh health signal, not yesterday's. Absent on entries written
     *  before the field existed (created-at is the fallback). */
    readonly stateSince?: number;
    /** Platform message ids of the delivered send. */
    readonly receipt?: string[];
    readonly tag?: string;
    /** Set by restart recovery: the platform may already hold this entry. */
    readonly recovered?: boolean;
}
/**
 * Enqueue's input: everything the caller owns (id, state, attempts,
 * createdAt, recovered are the ledger's to stamp).
 */
export type LedgerInput = Omit<LedgerEntry, "id" | "state" | "attempts" | "createdAt" | "recovered" | "message"> & {
    /** The full (bytes-bearing) message — the ledger serializes it. */
    readonly message: OutboundMessage;
    /**
     * The workspace file records backing the message's files: the
     * conversation id + workspace path the worker re-reads at send time
     * through `resolveFiles`. Absent when the entry has no files.
     */
    readonly files?: readonly {
        readonly conversationId: number;
        readonly path: string;
        readonly name: string;
        readonly mime?: string;
    }[];
};
/** The ledger's injectable options (tests inject a fake clock). */
export interface LedgerOptions {
    /** Clock ms for createdAt/prune decisions. Default: real. */
    readonly now?: () => number;
    readonly log?: EngineLog;
}
/** Delivered-entry retention (spec §8.6: pruned after 7 days). */
export declare const PRUNE_AFTER_MS = 604800000;
/**
 * The delivery ledger, one instance per engine. Reads
 * (`nextPending`/`failedSince`) serve the in-memory mirror loaded at
 * construction and refreshed inside every queued mutation — the
 * synchronous read contract the delivery worker's loop needs (its
 * `nextPending` call cannot await inside its tick).
 */
export declare class Ledger {
    private readonly file;
    private readonly now;
    private readonly log;
    private entries;
    constructor(path: string, opts?: LedgerOptions);
    /**
     * Enqueue one entry (state `pending`, stamped id/createdAt). Returns
     * undefined when `tag` is already present (the dedupe no-op) — the
     * caller logs nothing; the replay was harmless.
     */
    enqueue(entry: LedgerInput): Promise<LedgerEntry | undefined>;
    /**
     * The oldest pending entry for `channel`, or undefined. Synchronous
     * (the worker's loop is a tick, not an await point).
     */
    nextPending(channel: string): LedgerEntry | undefined;
    /** Transition one entry's state (attempting/delivered/failed). */
    mark(id: string, state: LedgerState, receipt?: readonly string[]): Promise<void>;
    /**
     * Restart recovery: every `attempting` entry becomes `pending` with
     * the `recovered` flag (the worker prefixes the marker at send time).
     * `pending` and terminal entries are untouched.
     */
    recoverAfterRestart(): Promise<void>;
    /** How many entries are `failed` having FAILED within the window —
     *  the state transition's clock, not creation: an old entry failing
     *  NOW still degrades health. */
    failedSince(ts: number): number;
    /**
     * Prune DELIVERED entries older than `PRUNE_AFTER_MS` (7 days). Failed
     * and pending entries are never pruned — a failed entry is the health
     * signal (§8.6: "nothing is dropped silently"), a pending entry is
     * undelivered work.
     */
    prune(now: number): Promise<void>;
    /**
     * Re-read one entry's file bytes at send time (the `files` path →
     * `readFile` rule). Returns the send-shaped files array, or undefined
     * when the entry has none.
     */
    resolveFiles(host: SigrunHost, entry: LedgerEntry): Promise<OutboundMessage["files"] | undefined>;
}
