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
import { randomUUID } from "node:crypto";
import { JsonFile } from "./json-file.js";
/** Delivered-entry retention (spec §8.6: pruned after 7 days). */
export const PRUNE_AFTER_MS = 604_800_000;
/**
 * The delivery ledger, one instance per engine. Reads
 * (`nextPending`/`failedSince`) serve the in-memory mirror loaded at
 * construction and refreshed inside every queued mutation — the
 * synchronous read contract the delivery worker's loop needs (its
 * `nextPending` call cannot await inside its tick).
 */
export class Ledger {
    file;
    now;
    log;
    entries = [];
    constructor(path, opts = {}) {
        this.file = new JsonFile(path, () => ({ entries: [] }));
        this.now = opts.now ?? Date.now;
        this.log = opts.log;
        // The mirror loads SYNCHRONOUSLY at construction (readSync): the
        // queue is empty here, so nothing can interleave; a second instance
        // over the same file (the restart path) observes the persisted
        // entries from its first read.
        this.entries = this.file.readSync().entries;
    }
    /**
     * Enqueue one entry (state `pending`, stamped id/createdAt). Returns
     * undefined when `tag` is already present (the dedupe no-op) — the
     * caller logs nothing; the replay was harmless.
     */
    async enqueue(entry) {
        const serialized = serializeMessage(entry.message, entry.files);
        const { message: _message, files: _files, ...rest } = entry;
        const stored = {
            ...rest,
            message: serialized,
            id: randomUUID(),
            state: "pending",
            attempts: 0,
            createdAt: this.now(),
        };
        const state = await this.file.update((draft) => {
            if (entry.tag !== undefined &&
                draft.entries.some((row) => row.tag === entry.tag)) {
                return;
            }
            draft.entries.push(stored);
            this.entries = draft.entries;
        });
        // The update's draft mutates in place; the tag-dedupe path left the
        // entry out (detect by id presence in the written state).
        const written = state.entries.some((row) => row.id === stored.id);
        return written ? stored : undefined;
    }
    /**
     * The oldest pending entry for `channel`, or undefined. Synchronous
     * (the worker's loop is a tick, not an await point).
     */
    nextPending(channel) {
        return this.entries.find((entry) => entry.channel === channel && entry.state === "pending");
    }
    /** Transition one entry's state (attempting/delivered/failed). */
    async mark(id, state, receipt) {
        await this.file.update((draft) => {
            const index = draft.entries.findIndex((row) => row.id === id);
            if (index === -1)
                return;
            const row = draft.entries[index];
            const next = {
                ...row,
                state,
                // An attempt transition counts the attempt; delivered/failed
                // keep the count the attempts produced.
                attempts: state === "attempting" ? row.attempts + 1 : row.attempts,
                ...(receipt === undefined ? {} : { receipt: [...receipt] }),
            };
            draft.entries[index] = next;
            this.entries = draft.entries;
        });
    }
    /**
     * Restart recovery: every `attempting` entry becomes `pending` with
     * the `recovered` flag (the worker prefixes the marker at send time).
     * `pending` and terminal entries are untouched.
     */
    async recoverAfterRestart() {
        const recovered = await this.file.update((draft) => {
            for (let index = 0; index < draft.entries.length; index++) {
                const row = draft.entries[index];
                if (row.state !== "attempting")
                    continue;
                draft.entries[index] = { ...row, state: "pending", recovered: true };
            }
            return;
        });
        if (recovered.entries.some((row) => row.recovered === true)) {
            this.log?.info("ledger: recovered attempting entries after restart");
        }
        this.entries = recovered.entries;
    }
    /** How many entries are `failed` with `createdAt >= ts` (health's window). */
    failedSince(ts) {
        return this.entries.filter((entry) => entry.state === "failed" && entry.createdAt >= ts).length;
    }
    /**
     * Prune DELIVERED entries older than `PRUNE_AFTER_MS` (7 days). Failed
     * and pending entries are never pruned — a failed entry is the health
     * signal (§8.6: "nothing is dropped silently"), a pending entry is
     * undelivered work.
     */
    async prune(now) {
        const pruned = await this.file.update((draft) => {
            const before = draft.entries.length;
            const kept = draft.entries.filter((entry) => entry.state !== "delivered" ||
                now - entry.createdAt < PRUNE_AFTER_MS);
            // In-place array replacement keeps the draft object identity.
            draft.entries.length = 0;
            draft.entries.push(...kept);
            if (kept.length !== before) {
                this.log?.debug(`ledger: pruned ${before - kept.length} delivered entries`);
            }
        });
        this.entries = pruned.entries;
    }
    /**
     * Re-read one entry's file bytes at send time (the `files` path →
     * `readFile` rule). Returns the send-shaped files array, or undefined
     * when the entry has none.
     */
    async resolveFiles(host, entry) {
        const specs = entry.message.files;
        if (specs === undefined || specs.length === 0)
            return undefined;
        const files = [];
        for (const spec of specs) {
            const read = await host.conversations.readFile(spec.conversationId, spec.path);
            files.push({
                name: spec.name,
                ...(spec.mime === undefined ? {} : { mime: spec.mime }),
                bytes: read.bytes,
            });
        }
        return files;
    }
}
/**
 * Strip the bytes out of an outbound message for persistence: the
 * `files` array is replaced by the workspace-path records the worker
 * re-reads through `resolveFiles`. A message carrying bytes WITHOUT a
 * file spec (the caller sent ephemeral buffers) drops them — the ledger
 * never persists bytes, and the send would need the path spec anyway.
 */
function serializeMessage(message, files) {
    if (files === undefined || files.length === 0) {
        return { chat: message.chat, text: message.text, ...pickOptional(message) };
    }
    return {
        chat: message.chat,
        text: message.text,
        ...pickOptional(message),
        files: files.map((file) => ({
            conversationId: file.conversationId,
            path: file.path,
            name: file.name,
            ...(file.mime === undefined ? {} : { mime: file.mime }),
        })),
    };
}
/** The optional outbound fields, copied when present. */
function pickOptional(message) {
    return {
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(message.buttons === undefined ? {} : { buttons: message.buttons }),
    };
}
