/**
 * The per-channel supervisor (spec §8.12): a backoff state machine over
 * ONE channel adapter. `start` resolves once the first attempt settled
 * (running or backoff — a failing adapter never wedges boot); retries
 * ride the injected timer.
 *
 * Pinned values (the plan's Global Constraints): the backoff delay
 * starts at 1000 ms and doubles per consecutive failure, capped at
 * 300000 ms, plus jitter from the injected `random()` — jitter only
 * ever ADDS time (the delay stays within [base, min(2·base, cap)]), so
 * a retry never fires early against the pinned floor. 600000 ms of
 * running RESETS the delay (a healthy stretch earns a fresh 1000 ms).
 *
 * State machine: a `not_configured` adapter is never started (terminal
 * state, the contract's rule). A rejected `start` and a later `ctx.fail`
 * both enter `backoff` and schedule ONE retry — the failure path is
 * event-driven, not a polling loop, so a healthy channel owns zero
 * timers. `stop()` cancels the pending retry, waits for an in-flight
 * attempt to settle, and awaits the adapter's optional `stop`.
 */
import type { ChannelContext, ChannelContribution } from "@sigrun/sigrun/extension";
import type { EngineLog } from "./log.js";
/** The supervision state machine's states (spec §8.12 status values).
 *  `failed` is the engine-side CONFIG-ERROR state — a supervisor never
 *  enters it (see engine.ts's static rows). */
export type ChannelState = "stopped" | "not_configured" | "connecting" | "running" | "backoff" | "failed";
/** The status-report callback a started adapter drives (the contract's
 *  `ChannelContext.status` parameter — only the states a LIVE adapter
 *  can report; `backoff`/`failed`/`stopped` are supervisor-owned). */
export type StatusSink = (state: {
    readonly state: "connecting" | "running";
    readonly detail?: string;
}) => void;
/** One channel's status row (the admin status route's shape). */
export interface ChannelStatus {
    readonly state: ChannelState;
    readonly detail?: string;
    /** Clock ms when the row entered its current state. */
    readonly since: number;
    readonly lastError?: string;
    readonly counts: {
        readonly admitted: number;
        readonly dropped: number;
        readonly delivered: number;
        readonly failed: number;
    };
}
/** The supervisor's injectable dependencies. */
export interface SupervisorDeps {
    /**
     * Build the ChannelContext the adapter's `start` receives, wiring the
     * engine-owned members (`receive`/`action`/`log`) and `status` to
     * `report`. The supervisor wraps the result's `fail` (failures route
     * here); every other member passes through verbatim.
     */
    makeContext(signal: AbortSignal, report: StatusSink): ChannelContext;
    /** Clock ms. */
    now(): number;
    /** [0, 1) — the backoff jitter source. */
    random(): number;
    /** Schedule `fn` at `ms`; the return value cancels it. */
    setTimer(fn: () => void, ms: number): () => void;
    readonly log: EngineLog;
}
/**
 * One channel adapter's supervisor: constructed per channel at engine
 * `start`, `start()` awaited by the engine, `stop()` awaited at engine
 * stop. Not restartable after `stop()` (the engine stops once per boot).
 */
export declare class Supervisor {
    private readonly entry;
    private readonly deps;
    private state;
    private stateSince;
    private detail;
    private lastError;
    private readonly counts;
    /** The delay head for the NEXT retry (doubling bookkeeping). */
    private delayMs;
    /** When the channel entered running (0 = not running now). */
    private runningSince;
    /**
     * When the channel became unhealthy (the FIRST failure after a
     * healthy stretch). Persists across retry cycles — a perpetually
     * failing channel's health dwell must not reset per attempt — and
     * clears only when a retry reaches running.
     */
    private unhealthySince;
    private cancelTimer;
    private stopped;
    private signal;
    /** The in-flight start attempt (stop awaits it before settling). */
    private attempt;
    constructor(entry: {
        extension: string;
        channel: ChannelContribution;
    }, deps: SupervisorDeps);
    /** The channel id (the status route's key). */
    get id(): string;
    /** The extension slug that contributed the channel (logging). */
    get extension(): string;
    /** The current status row (a copy — callers never mutate internals). */
    status(): ChannelStatus;
    /**
     * Begin supervision: resolves once the first attempt settled (running
     * or backoff). A `not_configured` adapter resolves immediately and is
     * never started.
     */
    start(signal: AbortSignal): Promise<void>;
    /** Stop supervision: cancel the retry, await the in-flight attempt and
     *  the adapter's optional `stop`. Idempotent. */
    stop(): Promise<void>;
    /** Count one admitted outcome (the engine's receive path reports). */
    countAdmitted(): void;
    /** Count one dropped outcome. */
    countDropped(): void;
    /** Count one delivered message (the outbound path, Task 5). */
    countDelivered(): void;
    /** Count one failed ledger entry (Task 5's worker reports). */
    countFailed(): void;
    /**
     * Unhealthy dwell at `now`: time since the channel first became
     * unhealthy WHILE it sits in `backoff` (the engine's §8.12 health
     * input). 0 when healthy — a config-error channel never reaches here
     * (it is an engine-side static row, never a supervisor).
     */
    unhealthyMs(now: number): number;
    /** Mark the channel running (the engine's own transitions, tests). */
    markRunning(detail?: string): void;
    /**
     * One start attempt: connecting → `channel.start(ctx)` → running, or
     * backoff through {@link onFailure}. Never throws.
     */
    private runAttempt;
    /**
     * Build the adapter's context: the engine's `makeContext` result with
     * `fail` intercepted (a post-connect failure routes into supervision,
     * never into the engine's log-only base).
     */
    private buildContext;
    /** The adapter's own connecting/running report. */
    private onReport;
    /**
     * A start rejection or `ctx.fail`: enter backoff and schedule exactly
     * ONE retry. Duplicates (a second `ctx.fail` while a retry is already
     * pending, or an in-flight start's rejection after its `ctx.fail`)
     * are ignored — the pending retry owns the recovery.
     */
    private onFailure;
    /** Schedule the retry at the doubling delay plus jitter. */
    private scheduleRetry;
    private setState;
}
