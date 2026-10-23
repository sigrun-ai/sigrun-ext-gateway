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
/** Initial backoff delay (ms) — the spec's "1 s doubling". */
const INITIAL_BACKOFF_MS = 1_000;
/** Backoff cap (ms) — the spec's "5 min". */
const MAX_BACKOFF_MS = 300_000;
/** Running time (ms) after which the backoff delay resets — the spec's
 *  "reset after 10 min running". */
const RUNNING_RESET_MS = 600_000;
/**
 * One channel adapter's supervisor: constructed per channel at engine
 * `start`, `start()` awaited by the engine, `stop()` awaited at engine
 * stop. Not restartable after `stop()` (the engine stops once per boot).
 */
export class Supervisor {
    entry;
    deps;
    state = "stopped";
    stateSince;
    detail;
    lastError;
    counts = {
        admitted: 0,
        dropped: 0,
        delivered: 0,
        failed: 0,
    };
    /** The delay head for the NEXT retry (doubling bookkeeping). */
    delayMs = INITIAL_BACKOFF_MS;
    /** When the channel entered running (0 = not running now). */
    runningSince = 0;
    /**
     * When the channel became unhealthy (the FIRST failure after a
     * healthy stretch). Persists across retry cycles — a perpetually
     * failing channel's health dwell must not reset per attempt — and
     * clears only when a retry reaches running.
     */
    unhealthySince;
    cancelTimer;
    stopped = false;
    signal;
    /** The in-flight start attempt (stop awaits it before settling). */
    attempt;
    constructor(entry, deps) {
        this.entry = entry;
        this.deps = deps;
        this.stateSince = deps.now();
    }
    /** The channel id (the status route's key). */
    get id() {
        return this.entry.channel.id;
    }
    /** The extension slug that contributed the channel (logging). */
    get extension() {
        return this.entry.extension;
    }
    /** The current status row (a copy — callers never mutate internals). */
    status() {
        return {
            state: this.state,
            ...(this.detail === undefined ? {} : { detail: this.detail }),
            since: this.stateSince,
            ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
            counts: { ...this.counts },
        };
    }
    /**
     * Begin supervision: resolves once the first attempt settled (running
     * or backoff). A `not_configured` adapter resolves immediately and is
     * never started.
     */
    async start(signal) {
        this.signal = signal;
        const readiness = await this.entry.channel.configured();
        if (readiness.status !== "ready") {
            // not_configured (the readiness union's only other member): the
            // adapter is never started (the contract's rule) and the detail
            // rides the status row.
            this.setState("not_configured", readiness.detail);
            return;
        }
        await this.runAttempt();
    }
    /** Stop supervision: cancel the retry, await the in-flight attempt and
     *  the adapter's optional `stop`. Idempotent. */
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        const attempt = this.attempt;
        if (attempt !== undefined)
            await attempt.catch(() => { });
        this.runningSince = 0;
        if (this.entry.channel.stop !== undefined) {
            try {
                await this.entry.channel.stop();
            }
            catch (error) {
                this.deps.log.error(`channel "${this.id}" stop failed`, error);
            }
        }
        this.setState("stopped");
    }
    /** Count one admitted outcome (the engine's receive path reports). */
    countAdmitted() {
        this.counts.admitted++;
    }
    /** Count one dropped outcome. */
    countDropped() {
        this.counts.dropped++;
    }
    /** Count one delivered message (the outbound path, Task 5). */
    countDelivered() {
        this.counts.delivered++;
    }
    /** Count one failed ledger entry (Task 5's worker reports). */
    countFailed() {
        this.counts.failed++;
    }
    /**
     * Unhealthy dwell at `now`: time since the channel first became
     * unhealthy WHILE it sits in `backoff` (the engine's §8.12 health
     * input). 0 when healthy — a config-error channel never reaches here
     * (it is an engine-side static row, never a supervisor).
     */
    unhealthyMs(now) {
        if (this.state !== "backoff")
            return 0;
        return now - (this.unhealthySince ?? this.stateSince);
    }
    /** Mark the channel running (the engine's own transitions, tests). */
    markRunning(detail) {
        if (this.runningSince === 0)
            this.runningSince = this.deps.now();
        this.unhealthySince = undefined;
        this.setState("running", detail);
    }
    /**
     * One start attempt: connecting → `channel.start(ctx)` → running, or
     * backoff through {@link onFailure}. Never throws.
     */
    async runAttempt() {
        const signal = this.signal;
        if (signal === undefined || this.stopped)
            return;
        this.setState("connecting");
        const ctx = this.buildContext(signal);
        const settled = (async () => {
            try {
                await this.entry.channel.start(ctx);
            }
            catch (error) {
                this.onFailure(error);
                return;
            }
            if (this.stopped)
                return;
            // A `ctx.fail` that fired while a hanging start later resolved:
            // the scheduled retry stands — never overwrite backoff with
            // running out from under it.
            if (this.state === "connecting")
                this.markRunning();
        })();
        this.attempt = settled;
        try {
            await settled;
        }
        catch (error) {
            // The inner function catches adapter failures; a throw past it
            // is a supervision bug — logged, never propagated (the loop
            // must keep serving the other channels).
            this.deps.log.error(`channel "${this.id}" supervision error`, error);
        }
        finally {
            this.attempt = undefined;
        }
    }
    /**
     * Build the adapter's context: the engine's `makeContext` result with
     * `fail` intercepted (a post-connect failure routes into supervision,
     * never into the engine's log-only base).
     */
    buildContext(signal) {
        const report = (state) => this.onReport(state);
        const base = this.deps.makeContext(signal, report);
        return {
            ...base,
            fail: (error) => this.onFailure(error),
        };
    }
    /** The adapter's own connecting/running report. */
    onReport(state) {
        if (this.stopped)
            return;
        if (state.state === "running")
            this.markRunning(state.detail);
        else
            this.setState("connecting", state.detail);
    }
    /**
     * A start rejection or `ctx.fail`: enter backoff and schedule exactly
     * ONE retry. Duplicates (a second `ctx.fail` while a retry is already
     * pending, or an in-flight start's rejection after its `ctx.fail`)
     * are ignored — the pending retry owns the recovery.
     */
    onFailure(error) {
        if (this.stopped)
            return;
        if (this.state === "backoff")
            return;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.deps.log.error(`channel "${this.id}" failed`, error);
        // The running reset: a channel that held running for 600000 ms
        // earns a fresh 1000 ms; anything shorter keeps the doubled delay.
        if (this.runningSince !== 0) {
            if (this.deps.now() - this.runningSince >= RUNNING_RESET_MS) {
                this.delayMs = INITIAL_BACKOFF_MS;
            }
            this.runningSince = 0;
        }
        if (this.unhealthySince === undefined) {
            this.unhealthySince = this.deps.now();
        }
        this.setState("backoff");
        this.scheduleRetry();
        // The doubling arms the NEXT failure (the retry this failure just
        // scheduled rides the current, undoubled delay).
        this.delayMs = Math.min(this.delayMs * 2, MAX_BACKOFF_MS);
    }
    /** Schedule the retry at the doubling delay plus jitter. */
    scheduleRetry() {
        const signal = this.signal;
        if (signal === undefined)
            return;
        const base = Math.min(this.delayMs, MAX_BACKOFF_MS);
        // Jitter ADDS up to the next doubling step: the delay stays in
        // [base, min(2·base, cap)] — never below the pinned floor, never
        // past the cap.
        const ceiling = Math.min(2 * base, MAX_BACKOFF_MS);
        const delay = base + this.deps.random() * (ceiling - base);
        this.cancelTimer?.();
        this.cancelTimer = this.deps.setTimer(() => {
            this.cancelTimer = undefined;
            void this.runAttempt();
        }, delay);
    }
    setState(state, detail) {
        this.state = state;
        this.stateSince = this.deps.now();
        this.detail = detail;
    }
}
