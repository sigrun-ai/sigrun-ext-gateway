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
 * count (Task 5: the engine-owned ledger feeds the `failedRecently`
 * seam — tests may still override it).
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
import { readConfig } from "./config.js";
import { createLog } from "./log.js";
import { createPipeline } from "./inbound/pipeline.js";
import { Supervisor, } from "./supervisor.js";
import { PairingStore } from "./access/pairing.js";
import { LinkCodes } from "./access/link-codes.js";
import { LoopGuard } from "./access/loop-guard.js";
import { ButtonTokens } from "./inbound/tokens.js";
import { BindingStore } from "./state/bindings.js";
import { IdentityStore } from "./state/identities.js";
import { Ledger } from "./state/ledger.js";
import { DeliveryWorker } from "./outbound/delivery.js";
import { onRunSettled } from "./outbound/settled.js";
import { hashId } from "./log.js";
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
    const stateDir = host.stores.paths.state;
    const gatewayDir = join(stateDir, "gateway");
    // The delivery ledger (Task 5): engine-wide (every channel's worker
    // pulls its own queue from it), built over the state dir at factory
    // time — the stores load synchronously, no timers (the pi lifecycle
    // rule holds). Restart recovery runs at `start` (the boot's one
    // recovery point) — a `recoverAfterRestart()` BEFORE any worker runs
    // re-arms `attempting` entries with the recovered flag.
    const ledger = new Ledger(join(gatewayDir, "ledger.json"), {
        now: timers.now,
        log,
    });
    // One delivery worker per supervised channel, keyed channel id
    // (built at start — a worker owns its channel's timers).
    const workers = new Map();
    // The ONE binding store: every pipeline (threaded through
    // PipelineDeps.bindings), the settled fan-out and the delivery
    // workers share THIS instance — JsonFile's write serialization is
    // PER INSTANCE, so a second store over the same file would interleave
    // its writes with this one's and lose updates.
    const bindings = new BindingStore(join(gatewayDir, "bindings.json"), {
        now: timers.now,
    });
    const failedRecently = deps.failedRecently ??
        (() => ledger.failedSince(timers.now() - 3_600_000));
    let channels = [];
    // One supervisor per supervised channel, keyed channel id.
    const supervisors = new Map();
    // Static rows for channels that never reach a supervisor, keyed id.
    const staticRows = new Map();
    // submissionId → the origin record (Task 3's pipeline writes; the
    // outbound tasks read). One map per ENGINE (shared across channels).
    const origins = new Map();
    // Every constructed channel pipeline's flush handle: stopIntake
    // flushes the open album windows through these (one per supervised
    // channel — the pipelines share state files but each owns its
    // channel's in-flight albums).
    const pipelines = [];
    let started = false;
    // The engine-wide access state (Task 4): ONE pairing queue, link-code
    // table, token table and loop guard shared by every channel pipeline
    // and the pair/link commands. Built over the engine's state dir at
    // factory time (cheap: the stores load synchronously; no timers, no
    // I/O beyond the state reads — the pi lifecycle rule holds).
    const access = {
        identities: new IdentityStore(join(gatewayDir, "identities.json")),
        pairing: new PairingStore(join(gatewayDir, "pairing.json")),
        linkCodes: new LinkCodes(),
        tokens: new ButtonTokens(),
        loopGuard: new LoopGuard(),
    };
    // The engine-owned half of every adapter context (Task 3's pipeline
    // drives `receive`; the supervisor's makeContext seam stays stable).
    // `supervisorOf` is resolved lazily — the context is built only during
    // a start ATTEMPT, after the supervisor exists (a direct reference
    // would hit the TDZ at construction).
    const makeContext = (_signal, report, supervisorOf, 
    /** The channel id — per-channel log attribution (Task 1's
     *  `channel:${id}` scoping; a bare "channel" scope loses which
     *  adapter a line came from). */
    id) => {
        const channelLog = ctxLog(`channel:${id}`);
        // ONE pipeline per engine (the state stores are shared; the
        // binding key carries the channel): every channel's receive runs
        // through it with ITS channel id and adapter. The pipeline's
        // origins map is the engine's outbound seam (Task 5 reads it).
        const channelEntry = channels.find((entry) => entry.channel.id === id);
        if (channelEntry === undefined) {
            // makeContext runs only inside a start attempt over a recorded
            // channel; reaching here means the supervisor wiring diverged.
            throw new Error(`gateway: channel "${id}" context built without its contribution`);
        }
        const receivePipeline = createPipeline({
            host,
            channel: channelEntry.channel,
            stateDir: gatewayDir,
            log: channelLog,
            origins,
            access,
            // The ONE engine-wide binding store — the fan-out and the delivery
            // workers share this exact instance (see its declaration).
            bindings,
        });
        pipelines.push(receivePipeline);
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
                        return { outcome: "dropped" };
                    }
                    const outcome = await receivePipeline(id, event, block);
                    if (outcome.outcome === "admitted") {
                        supervisorOf().countAdmitted();
                    }
                    else if (outcome.outcome === "dropped") {
                        supervisorOf().countDropped();
                    }
                    return outcome;
                }
                catch (error) {
                    // An engine failure (the §8.4 contract): the adapter does
                    // not ack, the platform redelivers, and the supervisor's
                    // counts stay honest (no admission claimed).
                    channelLog.error("receive failed", error);
                    throw error;
                }
            },
            // Button taps route through the pipeline's token handler (Task
            // 4: pair decisions; Task 9 adds interactions). A tap on an
            // unknown channel block drops like an event would.
            action: async (event) => {
                try {
                    const config = await readConfig(host);
                    const block = config.channels[id];
                    if (block === undefined || "failed" in block)
                        return;
                    await receivePipeline.action(id, event, block);
                }
                catch (error) {
                    // A tap failure never rejects the adapter's ack: the token is
                    // consumed, the decision lost — logged loud, never retried
                    // (a replayed tap is a no-op by the token's single use).
                    channelLog.error("action failed", error);
                }
            },
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
    // The Task 6 streaming seam's stub (false — no stream owns delivery
    // yet; Task 6 replaces this closure with the StreamRegistry). Declared
    // before the deps closure that reads it.
    const streamsStub = {
        finalize: async () => false,
    };
    /** The settled-run fan-out deps (the factory's `runSettled` closes over
     *  these — the same stores the pipelines and commands share, plus the
     *  delivery ledger and the Task 6 streaming stub). */
    const settledDeps = () => ({
        host,
        bindings,
        identities: access.identities,
        ledger,
        channelOf: (id) => channels.find((entry) => entry.channel.id === id)?.channel,
        configOf: async (id) => {
            const config = await readConfig(host);
            const block = config.channels[id];
            return block === undefined || "failed" in block ? undefined : block;
        },
        origins,
        streams: streamsStub,
        log,
    });
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
        pairingStatus: () => access.pairing.pending().map((row) => ({
            channel: row.channel,
            sender: hashId(row.senderId),
            createdAt: row.createdAt,
        })),
        /** The engine-wide access state (the commands and pipelines share). */
        accessState: () => access,
        /** The `/pair` decision deps over the shared state (the factory's
         *  command closes over these). */
        pairDeps: (hostArg) => ({
            host: hostArg,
            identities: access.identities,
            pairing: access.pairing,
            channelOf: (id) => channels.find((entry) => entry.channel.id === id)?.channel,
            log,
            now: timers.now,
        }),
        settle: async (event) => {
            // The fan-out runs over the engine's deps, then every LIVE
            // worker kicks (an entry for an unsupervised channel parks in
            // the ledger — the channel's next start drains it). The prune
            // rides settles too: a long-lived engine prunes without owning
            // a recurring timer.
            await onRunSettled(event, settledDeps());
            await ledger.prune(timers.now()).catch((error) => {
                log.error("ledger prune failed", error);
            });
            for (const worker of workers.values())
                worker.kick();
        },
        start: async (ctx) => {
            // ONE start per engine instance (the handle's lazy `started`
            // already guards re-reads; this guards a direct second call).
            if (started)
                return;
            started = true;
            channels = ctx.channels;
            await mkdir(gatewayDir, { recursive: true });
            // Ledger restart recovery runs BEFORE any worker (§8.6): every
            // `attempting` entry re-arms `pending` with the recovered flag,
            // and the workers resend them with the marker line. The prune of
            // delivered entries past 7 days rides the same point (plus every
            // settle — no recurring timer: the supervisor tests count the
            // engine's scheduled timers, and an idle engine owns ZERO).
            await ledger.recoverAfterRestart();
            await ledger.prune(timers.now()).catch((error) => {
                log.error("ledger prune failed", error);
            });
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
                    // A malformed block disables the channel with the reason; the
                    // row is `failed` and §8.12's health reads its dwell like any
                    // other `failed` state (degraded after 300000 ms).
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
                    }, id),
                    now: timers.now,
                    random: timers.random,
                    setTimer: timers.setTimer,
                    log: createLog(`channel:${id}`),
                });
                supervisors.set(id, supervisor);
                // The channel's delivery worker (Task 5): one in-flight send,
                // the pinned retry ladder, the ledger's queue. Built BEFORE the
                // supervisor starts (its first delivery may kick immediately —
                // recovery entries ride the same loop).
                const worker = new DeliveryWorker(entry.channel, ledger, {
                    bindings,
                    timeoutMs: 60_000,
                    delays: [1_000, 5_000, 30_000],
                    setTimer: timers.setTimer,
                    now: timers.now,
                    log: createLog(`channel:${id}`),
                });
                workers.set(id, worker);
                // The first attempt settles before start resolves (running
                // or backoff — a failing adapter never wedges boot).
                await supervisor.start(ctx.signal);
                // The recovery kick runs only once the ADAPTER is live (or in
                // backoff): a send before the adapter connected would burn the
                // entry's first attempt on a transport that cannot take it.
                worker.kick();
            }
        },
        stopIntake: async () => {
            // Intake closes before the shutdown drain (the ordering) — but
            // FIRST every open album window flushes: a shutdown inside the
            // 1500 ms merge window must submit the already-admitted album
            // events (they committed `seen`; without the flush, the
            // platform's redelivery would dedupe to a no-op and the album
            // would be lost). One failed album's flush is logged and never
            // strands the others (flushAlbums drains every group).
            const pending = [...pipelines];
            pipelines.length = 0;
            await Promise.all(pending.map((pipeline) => pipeline.flushAlbums()));
        },
        stop: async () => {
            // The adapters stop only once every settle has been delivered
            // (the ordering); a stop-before-start resolves (the lazy-start
            // shutdown edge in the handle's contract). The delivery workers
            // drain FIRST — a bounded window (30 s) for the pending entries,
            // then a hard stop (retry timers cancel; undelivered entries stay
            // pending for the next boot's recovery).
            const draining = [...workers.values()];
            workers.clear();
            const deadline = timers.now() + 30_000;
            await Promise.all(draining.map(async (worker) => {
                await worker.drain(deadline).catch(() => {
                    // A drain failure never blocks the stop: the entries stay
                    // queued (the ledger is the source of truth).
                });
                await worker.stop();
            }));
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
                if (row.state === "failed" &&
                    now - row.since > DEGRADED_AFTER_MS) {
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
