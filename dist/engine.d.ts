/**
 * The gateway engine (spec §8.0, gateway C2): chat-transport supervision
 * over the boot's channel bindings. ONE engine per boot; `start` runs
 * after the server listens, `stopIntake` before the shutdown drain,
 * `stop` after it.
 *
 * Task 1 ships the SKELETON: `start` creates the state directory (core
 * ensures only the root — spec §8.0 "the engine creates that directory
 * at start"), starts every READY channel adapter, and records the
 * channel set; `stopIntake`/`stop` resolve (adapters stop on `stop`);
 * `health` reads "ok". Later tasks fill supervision, the inbound
 * pipeline, delivery, and the §8.12 health derivation.
 *
 * `EngineInternals` is the test/task-internal surface (the state-dir
 * path, the recorded channel set) — NOT part of the loader contract,
 * which sees only the {@link GatewayEngine} four.
 */
import type { GatewayEngine, SigrunHost } from "@sigrun/sigrun/extension";
import { type EngineLog } from "./log.js";
/**
 * The engine's injectable dependencies (tests and later tasks). Task 1
 * carries only the log; every later seam lands here so the constructor
 * signature never changes twice.
 */
export interface EngineDeps {
    readonly log?: EngineLog;
}
/** The task-internal surface over the contract four (see the module doc). */
export interface EngineInternals {
    /** The engine's state directory: `<stateDir>/gateway` (the scoped
     *  `host.stores.paths.state` plus the engine's own segment). */
    readonly stateDir: string;
    /** The channel ids the last `start` recorded, in order. */
    readonly channelIds: () => readonly string[];
}
/**
 * Build the engine over the host. The factory wires the real
 * dependencies; tests inject the clock/log seams through the same
 * parameter.
 */
export declare function createEngine(host: SigrunHost, deps?: EngineDeps): GatewayEngine & EngineInternals;
