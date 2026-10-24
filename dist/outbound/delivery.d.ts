/**
 * The per-channel delivery worker (spec §8.6): ONE in-flight send per
 * channel, entries pulled from the ledger in enqueue order.
 *
 * Retry ladder (pinned): a `transient` failure retries at 1000, 5000
 * and 30000 ms, then the entry is `failed`. A `permanent` failure
 * fails at once. A `chat_gone` failure marks the binding dead
 * (future sends to that chat skip; the chat's next inbound message
 * clears it) and drops the entry. A send that exceeds the 60 s bound
 * (spec's Review Focus 2 — an adapter call that never resolves)
 * classifies TRANSIENT: the worker abandons the call, retries, and
 * never wedges the channel's queue.
 *
 * Recovered entries (restart recovery flagged them) are resent with the
 * leading "(resent after restart)" line — the platform may already
 * hold the message, and the marker tells the human what happened.
 *
 * `drain(deadlineMs)` is the shutdown path: send until the ledger is
 * empty or the deadline passes; retries are NOT waited out (a retry
 * timer armed by drain settles after stop() — the entry stays pending
 * and the next boot's recovery resends it).
 */
import type { ChannelContribution } from "@sigrun/sigrun/extension";
import type { Ledger } from "../state/ledger.js";
import type { BindingStore } from "../state/bindings.js";
import type { EngineLog } from "../log.js";
/** The worker's injectable dependencies. */
export interface DeliveryDeps {
    readonly bindings: BindingStore;
    /** The send bound (a hung adapter call never wedges the queue). */
    readonly timeoutMs: number;
    /** The pinned retry ladder: delays[attempt] before retry N. */
    readonly delays: readonly [number, number, number];
    /** Schedule `fn` at `ms`; the return value cancels it. */
    readonly setTimer: (fn: () => void, ms: number) => () => void;
    readonly log: EngineLog;
    /** Clock (the tests' virtual clock). Default: real. */
    readonly now?: () => number;
}
/** The pinned resend marker for recovered entries. */
export declare const RESENT_MARKER = "(resent after restart)";
/**
 * One channel's delivery worker. `kick()` starts the loop if idle (an
 * enqueue calls it); `drain(deadlineMs)` runs sends until empty or the
 * deadline; `stop()` cancels timers and joins the in-flight send. Not
 * restartable after `stop()` (the engine stops once per boot).
 */
export declare class DeliveryWorker {
    private readonly channel;
    private readonly ledger;
    private readonly deps;
    private readonly now;
    private busy;
    private stopped;
    /** The in-flight send's settle handle (stop joins it). */
    private inFlight;
    /** The cancel for the armed retry timer. */
    private cancelRetry;
    /** Deadline ms for the current drain (0 = no drain running). */
    private drainDeadline;
    constructor(channel: ChannelContribution, ledger: Ledger, deps: DeliveryDeps);
    /** Start the loop if idle (the enqueue-side poke). */
    kick(): void;
    /**
     * Send until the ledger's channel queue is empty or `deadlineMs`
     * (absolute clock ms) passes. Retries already scheduled fire on
     * their own timers — drain does not wait them out.
     */
    drain(deadlineMs: number): Promise<void>;
    /** Cancel the retry timer and join the in-flight send. Idempotent. */
    stop(): Promise<void>;
    /**
     * The steady-state loop: pull, send, repeat; a retry-armed state
     * parks until the timer fires (kick re-arms after each timer hop).
     */
    private runLoop;
    /**
     * Send one entry: attempting → send → delivered (receipt) / the
     * error-classified failure path. Returns false when the entry needs
     * a retry wait (the loop parks until the retry timer re-kicks) —
     * enqueue ORDER holds: no later entry overtakes a retrying one.
     * Never throws.
     */
    private sendOne;
    /**
     * The platform call, abandoned at `timeoutMs`: a send that exceeds
     * the bound classifies TRANSIENT (the worker retries, never wedges).
     */
    private boundedSend;
    /**
     * The classified failure path: transient retries (the ladder),
     * permanent fails at once, chat_gone marks the binding dead.
     * Returns false when a retry wait was armed (the caller parks).
     */
    private onSendError;
    /** A ledger mark with its own error isolation (never throws). */
    private markLedger;
    /**
     * The classification read (adapter's `classifyError` when present,
     * transient otherwise) with the timeout error forced transient.
     */
    private classify;
    /** The send-shaped message for one entry (the recovered marker rule). */
    private buildMessage;
}
/** The timeout error's name (matched by `classify`, never instanceof). */
export declare const SEND_TIMEOUT_NAME = "GatewaySendTimeout";
