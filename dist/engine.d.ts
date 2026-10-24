/**
 * The gateway engine (spec §8.0, gateway C2): chat-transport supervision
 * over the boot's channel bindings. ONE engine per boot; `start` runs
 * after the server listens, `stopIntake` before the shutdown drain,
 * `stop` after it.
 *
 * Task 2 owns supervision: `start` reads the LIVE config once for the
 * restart-required enablement (a channel absent from `channels`, an
 * `enabled: false`, or a `{failed}` config block never starts its
 * adapter — the engine records a static row instead), then hands every
 * enabled channel a {@link Supervisor}. Health (§8.12) reads the
 * supervisors' unhealthy dwell plus the ledger's failed-in-last-hour
 * count (the ledger lands in Task 5; until then the count reads 0
 * through the `failedRecently` dependency).
 *
 * The inbound pipeline (Task 3) drives `receive` (§8.4): the config
 * block is read LIVE per event, admission runs the ordered steps, and
 * the supervisor counts every outcome. `action` (button taps) stays a
 * no-op until the token table lands (Tasks 4/9).
 *
 * `EngineInternals` is the test/task-internal surface (the state-dir
 * path, the status read) — NOT part of the loader contract, which sees
 * only the {@link GatewayEngine} four.
 */
import type { GatewayEngine, SigrunHost } from "@sigrun/sigrun/extension";
import { type EngineLog } from "./log.js";
import { type ChannelStatus } from "./supervisor.js";
import type { PairDeps } from "./commands/pair.js";
import type { AccessState } from "./inbound/pipeline.js";
import type { StatusPairingRow } from "./status-route.js";
/**
 * The engine's injectable dependencies (tests and later tasks). Task 1
 * carried only the log; every later seam lands here so the constructor
 * signature never changes twice.
 */
export interface EngineDeps {
    readonly log?: EngineLog;
    /** The timer bundle supervision rides. Default: real clock, real
     *  timers, crypto random (the factory never wires a timer at
     *  construction — the pi lifecycle rule; the supervisor starts them
     *  only from its `start`). */
    readonly timers?: {
        now(): number;
        random(): number;
        setTimer(fn: () => void, ms: number): () => void;
    };
    /**
     * The ledger's failed-in-last-hour count (§8.12's second health
     * input). The ledger lands in Task 5; the default reads 0.
     */
    readonly failedRecently?: () => number;
}
/** The task-internal surface over the contract four (see the module doc). */
export interface EngineInternals {
    /** The engine's state directory: `<stateDir>/gateway` (the scoped
     *  `host.stores.paths.state` plus the engine's own segment). */
    readonly stateDir: string;
    /** The channel ids the last `start` recorded, in order. */
    readonly channelIds: () => readonly string[];
    /**
     * The status route's read (Task 2): every channel's current row —
     * supervised and static (config-error/disabled) alike.
     */
    status(): {
        readonly channels: Readonly<Record<string, ChannelStatus>>;
    };
    /**
     * The status route's pairing read (Task 4): every live pending
     * request WITHOUT the code (hashed sender — §8.12's rule that
     * operator output never carries raw platform ids).
     */
    pairingStatus(): readonly StatusPairingRow[];
    /** The engine-wide access state (pipelines and commands share it). */
    accessState(): AccessState;
    /** The `/pair` decision deps over the shared state (the factory's
     *  command closes over these — `host` is the factory's own host). */
    pairDeps(host: SigrunHost): PairDeps;
}
/**
 * Build the engine over the host. The factory wires the real
 * dependencies; tests inject the clock/log/timer seams through the same
 * parameter.
 */
export declare function createEngine(host: SigrunHost, deps?: EngineDeps): GatewayEngine & EngineInternals;
