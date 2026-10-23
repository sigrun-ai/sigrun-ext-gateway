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
 * The inbound pipeline (Task 3) is the real consumer of `receive`/
 * `action`: before it lands, an adapter event admitted here is
 * deliberately DROPPED (the outcome the adapter's ack contract treats
 * as safe — dedupe makes a later retry safe).
 *
 * `EngineInternals` is the test/task-internal surface (the state-dir
 * path, the status read) — NOT part of the loader contract, which sees
 * only the {@link GatewayEngine} four.
 */
import type { GatewayEngine, SigrunHost } from "@sigrun/sigrun/extension";
import { type EngineLog } from "./log.js";
import { type ChannelStatus } from "./supervisor.js";
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
}
/**
 * Build the engine over the host. The factory wires the real
 * dependencies; tests inject the clock/log/timer seams through the same
 * parameter.
 */
export declare function createEngine(host: SigrunHost, deps?: EngineDeps): GatewayEngine & EngineInternals;
