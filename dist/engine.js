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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./config.js";
import { createLog } from "./log.js";
import { Supervisor, } from "./supervisor.js";
/** The engine's own timer defaults (the real world). */
function defaultTimers() {
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
/** The failed-ledger window (ms) health reads (§8.12 — one hour). */
const FAILED_LEDGER_WINDOW_MS = 3_600_000;
void FAILED_LEDGER_WINDOW_MS;
/** One static (never-supervised) status row. */
function staticRow(state, detail, since) {
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
export function createEngine(host, deps = {}) {
    const log = deps.log ?? createLog("engine");
    const timers = deps.timers ?? defaultTimers();
    const failedRecently = deps.failedRecently ?? (() => 0);
    const stateDir = host.stores.paths.state;
    const gatewayDir = join(stateDir, "gateway");
    let channels = [];
    // One supervisor per supervised channel, keyed channel id.
    const supervisors = new Map();
    // Static rows for channels that never reach a supervisor, keyed id.
    const staticRows = new Map();
    let started = false;
    // The engine-owned half of every adapter context (Task 3's pipeline
    // replaces the drop stubs; the shape lands here so the supervisor's
    // makeContext seam stays stable). `supervisorOf` is resolved lazily —
    // the context is built only during a start ATTEMPT, after the
    // supervisor exists (a direct reference would hit the TDZ at
    // construction).
    const makeContext = (_signal, report, supervisorOf) => {
        const channelLog = ctxLog("channel");
        return {
            signal: _signal,
            // The three stubs below deliberately no-op/drop: the inbound
            // pipeline (Task 3) is the real consumer — before it lands, an
            // adapter event admitted here would be silently processed twice
            // or lost, so the honest engine DROPS (the outcome the
            // adapter's ack contract treats as safe: dedupe makes a later
            // retry safe). The supervisor still counts the outcome — the
            // status route's counts are live from day one.
            receive: async () => {
                supervisorOf().countDropped();
                return { outcome: "dropped" };
            },
            // Button taps have no token table until Task 4/9 — swallow.
            action: async () => { },
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
    const ctxLog = (scope) => ({
        info: (msg) => log.info(`[${scope}] ${msg}`),
        warn: (msg) => log.warn(`[${scope}] ${msg}`),
        error: (msg, error) => log.error(`[${scope}] ${msg}`, error),
        debug: (msg) => log.debug(`[${scope}] ${msg}`),
        once: (key, level, msg) => log.once(key, level, `[${scope}] ${msg}`),
    });
    const status = () => {
        const channelsOut = {};
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
        start: async (ctx) => {
            // ONE start per engine instance (the handle's lazy `started`
            // already guards re-reads; this guards a direct second call).
            if (started)
                return;
            started = true;
            channels = ctx.channels;
            await mkdir(gatewayDir, { recursive: true });
            // Enablement is restart-required (spec §8.1): read ONCE at start.
            const config = await readConfig(host);
            log.info(`started: ${channels.length} channel(s) [${channels
                .map((entry) => `${entry.extension}/${entry.channel.id}`)
                .join(", ")}]`);
            for (const entry of channels) {
                const id = entry.channel.id;
                const block = config.channels[id];
                if (block === undefined) {
                    // Absent from `channels` = disabled (spec §8.1).
                    staticRows.set(id, staticRow("stopped", "channel not configured", timers.now()));
                    log.info(`channel "${id}" not in settings — skipped`);
                    continue;
                }
                if ("failed" in block) {
                    // A malformed block disables the channel with the reason —
                    // config error, never health-degrading (§8.12 keys on
                    // backoff/failed TIME; a config failure never entered it).
                    staticRows.set(id, staticRow("failed", block.failed, timers.now()));
                    log.warn(`channel "${id}" config failed: ${block.failed}`);
                    continue;
                }
                if (!block.enabled) {
                    staticRows.set(id, staticRow("stopped", "disabled", timers.now()));
                    log.info(`channel "${id}" disabled via settings`);
                    continue;
                }
                const supervisor = new Supervisor(entry, {
                    makeContext: (signal, report) => makeContext(signal, report, () => {
                        // The lazy lookup: the context is built only inside a start
                        // attempt, after `supervisors.set` ran.
                        const current = supervisors.get(id);
                        if (current === undefined) {
                            throw new Error(`gateway: channel "${id}" context built without a supervisor`);
                        }
                        return current;
                    }),
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
        stopIntake: async () => {
            // Intake closes before the shutdown drain (the ordering); Task 1
            // has no intake machinery yet — admission-level wiring lands with
            // the inbound pipeline (Task 3).
        },
        stop: async () => {
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
        health: () => {
            // §8.12: degraded when any enabled, configured channel has been
            // in backoff/failed for over 300000 ms, or the ledger holds
            // failed entries from the last hour. Static rows never degrade
            // (config errors are operator-visible, not flapping).
            const now = timers.now();
            for (const supervisor of supervisors.values()) {
                if (supervisor.unhealthyMs(now) > DEGRADED_AFTER_MS) {
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
