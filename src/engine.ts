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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	ChannelContribution,
	GatewayEngine,
	GatewayEngineContext,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { createLog, type EngineLog } from "./log.js";

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
export function createEngine(
	host: SigrunHost,
	deps: EngineDeps = {},
): GatewayEngine & EngineInternals {
	const log = deps.log ?? createLog("engine");
	const stateDir = host.stores.paths.state;
	const gatewayDir = join(stateDir, "gateway");
	let channels: readonly {
		extension: string;
		channel: ChannelContribution;
	}[] = [];
	// The started adapters' stop functions (an adapter may carry an
	// optional `stop`; the engine calls it on its own stop).
	let stops: Array<() => Promise<void> | void> = [];
	let started = false;

	return {
		stateDir: gatewayDir,
		channelIds: () => channels.map((entry) => entry.channel.id),
		start: async (ctx: GatewayEngineContext): Promise<void> => {
			// ONE start per engine instance (the handle's lazy `started`
			// already guards re-reads; this guards a direct second call).
			if (started) return;
			started = true;
			channels = ctx.channels;
			await mkdir(gatewayDir, { recursive: true });
			log.info(
				`started: ${channels.length} channel(s) [${channels
					.map((entry) => `${entry.extension}/${entry.channel.id}`)
					.join(", ")}]`,
			);
			// Supervision lands in Task 2; Task 1 starts every READY adapter
			// directly and records its stop. An unconfigured adapter is never
			// started (the contract's rule); a start failure propagates to
			// the host handle, which latches degraded.
			const adapterStops: Array<() => Promise<void> | void> = [];
			for (const entry of channels) {
				const readiness = await entry.channel.configured();
				if (readiness.status !== "ready") {
					log.info(`channel "${entry.channel.id}" ${readiness.status}${readiness.detail === undefined ? "" : `: ${readiness.detail}`}`);
					continue;
				}
				await entry.channel.start({
					signal: ctx.signal,
					// The three stubs below deliberately no-op: the inbound pipeline
					// (Task 3) is the real consumer of these — before it lands, an
					// adapter event admitted here would be silently processed twice
					// or lost, so the honest skeleton DROPS (the outcome the adapter's
					// ack contract treats as safe: dedupe makes a later retry safe).
					receive: async () => ({ outcome: "dropped" as const }),
					// Button taps have no token table until Task 4/9 — swallow.
					action: async () => {},
					// No supervisor reads status until Task 2 — swallow.
					status: () => {},
					fail: (error) => {
						log.error(`channel "${entry.channel.id}" failed`, error);
					},
					log: createLog(`channel:${entry.channel.id}`),
				});
				if (entry.channel.stop !== undefined) {
					adapterStops.push(() => entry.channel.stop?.());
				}
			}
			stops = adapterStops;
		},

		stopIntake: async (): Promise<void> => {
			// Intake closes before the shutdown drain (the ordering); Task 1
			// has no intake machinery yet — admission-level wiring lands with
			// the inbound pipeline (Task 3).
		},

		stop: async (): Promise<void> => {
			// The adapters stop only once every settle has been delivered
			// (the ordering); a stop-before-start resolves (the lazy-start
			// shutdown edge in the handle's contract).
			const pending = stops;
			stops = [];
			for (const stop of pending) await stop();
			if (started) {
				log.info("stopped");
			}
		},

		health: (): "ok" | "degraded" => "ok",
	};
}
