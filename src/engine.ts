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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	ChannelContext,
	ChannelContribution,
	GatewayEngine,
	GatewayEngineContext,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { readConfig } from "./config.js";
import { createLog, type EngineLog } from "./log.js";
import { createPipeline } from "./inbound/pipeline.js";
import {
	Supervisor,
	type ChannelState,
	type ChannelStatus,
} from "./supervisor.js";

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
	status(): { readonly channels: Readonly<Record<string, ChannelStatus>> };
}

/** The engine's own timer defaults (the real world). */
function defaultTimers(): NonNullable<EngineDeps["timers"]> {
	return {
		now: () => Date.now(),
		// The jitter source is RANDOM (never the clock): a deterministic
		// sequence would phase-lock concurrent deployments onto the same
		// retry beat.
		random: () => Math.random(),
		setTimer: (fn, ms) => {
			const handle = setTimeout(fn, ms);
			return () => clearTimeout(handle);
		},
	};
}

/** The unhealthy-dwell threshold (ms) before health degrades (§8.12). */
const DEGRADED_AFTER_MS = 300_000;

/** One static (never-supervised) status row. */
function staticRow(
	state: ChannelState,
	detail: string,
	since: number,
): ChannelStatus {
	return {
		state,
		detail,
		since,
		counts: { admitted: 0, dropped: 0, delivered: 0, failed: 0 },
	};
}

/**
 * Build the engine over the host. The factory wires the real
 * dependencies; tests inject the clock/log/timer seams through the same
 * parameter.
 */
export function createEngine(
	host: SigrunHost,
	deps: EngineDeps = {},
): GatewayEngine & EngineInternals {
	const log = deps.log ?? createLog("engine");
	const timers = deps.timers ?? defaultTimers();
	const failedRecently = deps.failedRecently ?? (() => 0);
	const stateDir = host.stores.paths.state;
	const gatewayDir = join(stateDir, "gateway");
	let channels: readonly {
		extension: string;
		channel: ChannelContribution;
	}[] = [];
	// One supervisor per supervised channel, keyed channel id.
	const supervisors = new Map<string, Supervisor>();
	// Static rows for channels that never reach a supervisor, keyed id.
	const staticRows = new Map<string, ChannelStatus>();
	// submissionId → the origin record (Task 3's pipeline writes; the
	// outbound tasks read). One map per ENGINE (shared across channels).
	const origins = new Map<
		import("@earendil-works/pi-durable").SubmissionId,
		import("./inbound/pipeline.js").SubmissionOrigin
	>();
	let started = false;

	// The engine-owned half of every adapter context (Task 3's pipeline
	// drives `receive`; the supervisor's makeContext seam stays stable).
	// `supervisorOf` is resolved lazily — the context is built only during
	// a start ATTEMPT, after the supervisor exists (a direct reference
	// would hit the TDZ at construction).
	const makeContext = (
		_signal: AbortSignal,
		report: (state: {
			readonly state: "connecting" | "running";
			readonly detail?: string;
		}) => void,
		supervisorOf: () => Supervisor,
		/** The channel id — per-channel log attribution (Task 1's
		 *  `channel:${id}` scoping; a bare "channel" scope loses which
		 *  adapter a line came from). */
		id: string,
	): ChannelContext => {
		const channelLog = ctxLog(`channel:${id}`);
		// ONE pipeline per engine (the state stores are shared; the
		// binding key carries the channel): every channel's receive runs
		// through it with ITS channel id and adapter. The pipeline's
		// origins map is the engine's outbound seam (Task 5 reads it).
		const channelEntry = channels.find(
			(entry) => entry.channel.id === id,
		);
		if (channelEntry === undefined) {
			// makeContext runs only inside a start attempt over a recorded
			// channel; reaching here means the supervisor wiring diverged.
			throw new Error(
				`gateway: channel "${id}" context built without its contribution`,
			);
		}
		const receivePipeline = createPipeline({
			host,
			channel: channelEntry.channel,
			stateDir: gatewayDir,
			log: channelLog,
			origins,
		});
		return {
			signal: _signal,
			// The §8.4 pipeline: the config block is read LIVE per event
			// (every field but `enabled` is per-event); a `{failed}` or
			// absent block drops (the channel's enablement was read once at
			// start — a supervised channel whose config went bad drops
			// events until its next restart).
			receive: async (event) => {
				try {
					const config = await readConfig(host);
					const block = config.channels[id];
					if (block === undefined || "failed" in block) {
						supervisorOf().countDropped();
						return { outcome: "dropped" as const };
					}
					const outcome = await receivePipeline(id, event, block);
					if (outcome.outcome === "admitted") {
						supervisorOf().countAdmitted();
					} else if (outcome.outcome === "dropped") {
						supervisorOf().countDropped();
					}
					return outcome;
				} catch (error) {
					// An engine failure (the §8.4 contract): the adapter does
					// not ack, the platform redelivers, and the supervisor's
					// counts stay honest (no admission claimed).
					channelLog.error("receive failed", error);
					throw error;
				}
			},
			// Button taps have no token table until Task 4/9 — swallow.
			action: async () => {},
			status: report,
			fail: () => {
				// The supervisor wraps this member (its own fail routes into
				// supervision); reaching the base means the wrapper was
				// bypassed — log it, never crash.
				log.warn("channel fail reached the engine base context");
			},
			log: channelLog,
		};
	};
	const ctxLog = (scope: string): EngineLog => ({
		info: (msg) => log.info(`[${scope}] ${msg}`),
		warn: (msg) => log.warn(`[${scope}] ${msg}`),
		error: (msg, error) => log.error(`[${scope}] ${msg}`, error),
		debug: (msg) => log.debug(`[${scope}] ${msg}`),
		once: (key, level, msg) => log.once(key, level, `[${scope}] ${msg}`),
	});

	const status = (): {
		readonly channels: Readonly<Record<string, ChannelStatus>>;
	} => {
		const channelsOut: Record<string, ChannelStatus> = {};
		for (const { channel } of channels) {
			const supervised = supervisors.get(channel.id);
			channelsOut[channel.id] = supervised
				? supervised.status()
				: (staticRows.get(channel.id) ??
					staticRow("stopped", "never started", timers.now()));
		}
		return { channels: channelsOut };
	};

	return {
		stateDir: gatewayDir,
		channelIds: () => channels.map((entry) => entry.channel.id),
		status,
		start: async (ctx: GatewayEngineContext): Promise<void> => {
			// ONE start per engine instance (the handle's lazy `started`
			// already guards re-reads; this guards a direct second call).
			if (started) return;
			started = true;
			channels = ctx.channels;
			await mkdir(gatewayDir, { recursive: true });
			// Enablement is restart-required (spec §8.1): read ONCE at start.
			const config = await readConfig(host);
			log.info(
				`started: ${channels.length} channel(s) [${channels
					.map((entry) => `${entry.extension}/${entry.channel.id}`)
					.join(", ")}]`,
			);
			for (const entry of channels) {
				const id = entry.channel.id;
				const block = config.channels[id];
				if (block === undefined) {
					// Absent from `channels` = disabled (spec §8.1).
					staticRows.set(
						id,
						staticRow("stopped", "channel not configured", timers.now()),
					);
					log.info(`channel "${id}" not in settings — skipped`);
					continue;
				}
				if ("failed" in block) {
					// A malformed block disables the channel with the reason; the
					// row is `failed` and §8.12's health reads its dwell like any
					// other `failed` state (degraded after 300000 ms).
					staticRows.set(
						id,
						staticRow("failed", block.failed, timers.now()),
					);
					log.warn(`channel "${id}" config failed: ${block.failed}`);
					continue;
				}
				if (!block.enabled) {
					staticRows.set(
						id,
						staticRow("stopped", "disabled", timers.now()),
					);
					log.info(`channel "${id}" disabled via settings`);
					continue;
				}
				const supervisor = new Supervisor(entry, {
					makeContext: (signal: AbortSignal, report) =>
						makeContext(signal, report, () => {
							// The lazy lookup: the context is built only inside a start
							// attempt, after `supervisors.set` ran.
							const current = supervisors.get(id);
							if (current === undefined) {
								throw new Error(
									`gateway: channel "${id}" context built without a supervisor`,
								);
							}
							return current;
						}, id),
					now: timers.now,
					random: timers.random,
					setTimer: timers.setTimer,
					log: createLog(`channel:${id}`),
				});
				supervisors.set(id, supervisor);
				// The first attempt settles before start resolves (running
				// or backoff — a failing adapter never wedges boot).
				await supervisor.start(ctx.signal);
			}
		},

		stopIntake: async (): Promise<void> => {
			// Intake closes before the shutdown drain (the ordering). The
			// Task 3 pipeline has no long-lived intake machinery (every
			// receive settles with its outcome); the album close timers —
			// the one deferred submission path — are awaited by `stop`'s
			// supervisor drain via each adapter's stop.
		},

		stop: async (): Promise<void> => {
			// The adapters stop only once every settle has been delivered
			// (the ordering); a stop-before-start resolves (the lazy-start
			// shutdown edge in the handle's contract).
			const pending = [...supervisors.values()];
			supervisors.clear();
			await Promise.all(pending.map((supervisor) => supervisor.stop()));
			if (started) {
				log.info("stopped");
			}
		},

		health: (): "ok" | "degraded" => {
			// §8.12: degraded when any enabled, configured channel has been
				// in backoff/failed for over 300000 ms, or the ledger holds
				// failed entries from the last hour (the window is Task 5's
				// `failedRecently` dependency — the engine never reads a clock
				// against the ledger itself). Supervisors own `backoff` dwell;
			// static rows own `failed` dwell (config-error channels).
			const now = timers.now();
			for (const supervisor of supervisors.values()) {
				if (supervisor.unhealthyMs(now) > DEGRADED_AFTER_MS) {
					return "degraded";
				}
			}
			for (const row of staticRows.values()) {
				if (
					row.state === "failed" &&
					now - row.since > DEGRADED_AFTER_MS
				) {
					return "degraded";
				}
			}
			if (failedRecently() > 0) {
				return "degraded";
			}
			return "ok";
		},
	};
}
