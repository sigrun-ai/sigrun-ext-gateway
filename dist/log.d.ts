/**
 * Engine logging + id hashing (spec §8.0/§8.12): one scoped console
 * logger with a per-process `once` dedupe (per-key — a repeated warn
 * fires a single line, never one per event), and `hashId` — the
 * non-reversible form sender ids take in status output.
 */
/** The irreversible form a platform sender id takes in operator-facing
 *  output: the sha256 digest's first 8 hex chars (the plan's pinned
 *  format — enough to correlate without leaking the raw platform id). */
export declare function hashId(id: string): string;
/** One scoped logger: console methods plus a per-key `once`. */
export interface EngineLog {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string, error?: unknown): void;
    debug(msg: string): void;
    /** Emit `msg` at `level` ONCE per process per `key` (per-key dedupe). */
    once(key: string, level: "info" | "warn", msg: string): void;
}
/** Build the scoped console logger (the `gateway:` prefix names the engine). */
export declare function createLog(scope: string): EngineLog;
