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
import { hashId } from "../log.js";
/** The pinned resend marker for recovered entries. */
export const RESENT_MARKER = "(resent after restart)";
/**
 * One channel's delivery worker. `kick()` starts the loop if idle (an
 * enqueue calls it); `drain(deadlineMs)` runs sends until empty or the
 * deadline; `stop()` cancels timers and joins the in-flight send. Not
 * restartable after `stop()` (the engine stops once per boot).
 */
export class DeliveryWorker {
    channel;
    ledger;
    deps;
    now;
    busy = false;
    stopped = false;
    /** The in-flight send's settle handle (stop joins it). */
    inFlight;
    /** The cancel for the armed retry timer. */
    cancelRetry;
    constructor(channel, ledger, deps) {
        this.channel = channel;
        this.ledger = ledger;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }
    /** Start the loop if idle (the enqueue-side poke). A no-op while a
     *  drain owns the queue (the drain IS the loop until it resolves). */
    kick() {
        if (this.stopped || this.busy)
            return;
        const loop = this.runLoop();
        this.inFlight = loop.catch((error) => {
            // A loop failure is engine-side (the ledger or the adapter
            // wrapper): logged loud, never silent — the channel's queue
            // stays honest (the next kick retries).
            this.deps.log.error(`delivery: loop failed (channel "${this.channel.id}")`, error);
        });
        void loop;
    }
    /**
     * Send until the ledger's channel queue is empty or `deadlineMs`
     * (absolute clock ms) passes. The drain TAKES OWNERSHIP of the
     * queue: `busy` is set for its duration (a kick during a drain is a
     * no-op), the armed retry timer is CANCELLED (the drain pulls the
     * re-pended entry directly — no timer-driven second loop races
     * it), and any in-flight loop is joined first. Retries are NOT
     * waited out: a retry-armed entry parks the drain (the entry stays
     * pending; the next boot's recovery resends it).
     */
    async drain(deadlineMs) {
        if (this.stopped)
            return;
        // Cancel the pending retry: the drain owns the queue now.
        this.cancelRetry?.();
        this.cancelRetry = undefined;
        // Join any in-flight loop before taking the busy flag.
        await this.inFlight;
        if (this.stopped)
            return;
        if (this.busy) {
            // A concurrent drain (the engine's stop is idempotent, but a
            // caller may race): join it rather than run a second loop.
            await this.inFlight;
            return;
        }
        this.busy = true;
        try {
            for (;;) {
                if (this.stopped)
                    return;
                if (this.now() >= deadlineMs)
                    return;
                const entry = this.ledger.nextPending(this.channel.id);
                if (entry === undefined)
                    return;
                const progressed = await this.sendOne(entry);
                if (!progressed)
                    return;
            }
        }
        finally {
            this.busy = false;
        }
    }
    /** Cancel the retry timer and join the in-flight send. Idempotent. */
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.cancelRetry?.();
        this.cancelRetry = undefined;
        const flight = this.inFlight;
        if (flight !== undefined)
            await flight.catch(() => { });
    }
    /**
     * The steady-state loop: pull, send, repeat; a retry-armed state
     * parks until the timer fires (kick re-arms after each timer hop).
     */
    async runLoop() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            for (;;) {
                if (this.stopped)
                    return;
                const entry = this.ledger.nextPending(this.channel.id);
                if (entry === undefined)
                    return;
                const progressed = await this.sendOne(entry);
                if (!progressed) {
                    // A retry is armed (or the entry is terminal-failed): the loop
                    // parks — the retry timer's kick() restarts it. Enqueue order
                    // holds (no later entry overtakes a retrying one).
                    return;
                }
            }
        }
        finally {
            this.busy = false;
        }
    }
    /**
     * Send one entry: attempting → send → delivered (receipt) / the
     * error-classified failure path. Returns false when the entry needs
     * a retry wait (the loop parks until the retry timer re-kicks) —
     * enqueue ORDER holds: no later entry overtakes a retrying one.
     * Never throws.
     */
    async sendOne(entry) {
        try {
            // Resolution belongs inside the classified boundary: a deleted
            // or unreadable file must fail this entry, never wedge the queue.
            const message = await this.buildMessage(entry);
            // The attempting mark rides the same isolation as the rest: a
            // failing ledger write is LOGGED and the send does not run (an
            // unmarked entry must not be sent — the crash window would
            // duplicate it on recovery).
            // A refused claim means the entry is no longer pending (a
            // settlement cancelled it between the loop's read and here).
            // Sending it anyway would deliver a live prompt for a decided
            // interaction, so stop: the cancellation is the barrier.
            if (!(await this.ledger.mark(entry.id, "attempting"))) {
                this.deps.counts?.cancelled?.();
                return true;
            }
            const receipt = entry.kind === "edit"
                ? await this.boundedEdit(entry, message)
                : await this.boundedSend(message);
            await this.ledger.mark(entry.id, "delivered", receipt.messageIds);
            if (entry.kind === "interaction") {
                await this.deps.onInteractionReceipt?.(entry, receipt);
            }
            this.deps.counts?.delivered();
            return true;
        }
        catch (error) {
            return await this.onSendError(entry, error);
        }
    }
    /**
     * The platform call, abandoned at `timeoutMs`: a send that exceeds
     * the bound classifies TRANSIENT (the worker retries, never wedges).
     */
    async boundedSend(message) {
        return await new Promise((resolve, reject) => {
            let settled = false;
            const timer = this.deps.setTimer(() => {
                if (settled)
                    return;
                settled = true;
                reject(timeoutError(this.deps.timeoutMs));
            }, this.deps.timeoutMs);
            this.channel
                .send(message)
                .then((receipt) => {
                if (settled)
                    return;
                settled = true;
                timer();
                resolve(receipt);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                timer();
                reject(error);
            })
                .catch((error) => {
                // The .then handlers never throw; the catch is the
                // belt-and-braces shape for a misbehaving adapter.
                if (settled)
                    return;
                settled = true;
                timer();
                reject(error);
            });
        });
    }
    /** Apply an edit entry; its ledger row carries the target MessageRef. */
    async boundedEdit(entry, message) {
        if (entry.ref === undefined || this.channel.edit === undefined) {
            const error = new Error("gateway: edit delivery requires a ref and adapter edit()");
            error.name = EDIT_PRECONDITION_ERROR;
            throw error;
        }
        await new Promise((resolve, reject) => {
            let settled = false;
            const timer = this.deps.setTimer(() => {
                if (settled)
                    return;
                settled = true;
                reject(timeoutError(this.deps.timeoutMs));
            }, this.deps.timeoutMs);
            this.channel.edit(entry.ref, message).then(() => {
                if (settled)
                    return;
                settled = true;
                timer();
                resolve();
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                timer();
                reject(error);
            });
        });
        return { messageIds: [entry.ref.messageId] };
    }
    /**
     * The classified failure path: transient retries (the ladder),
     * permanent fails at once, chat_gone marks the binding dead.
     * Returns false when a retry wait was armed (the caller parks).
     */
    async onSendError(entry, error) {
        const kind = this.classify(error);
        const detail = error instanceof Error ? error.message : String(error);
        // A ledger-mark failure arrives here too (sendOne's try wraps the
        // attempting mark): it is NOT a send failure — a transient retry of
        // an unmarked entry would double-send after recovery. Mark errors
        // log loud and park the entry as-is (the next boot's recovery owns
        // the resend).
        if (kind === "chat_gone") {
            if (entry.bindingKey !== undefined) {
                try {
                    await this.deps.bindings.markDead(entry.bindingKey);
                }
                catch (markError) {
                    this.deps.log.error(`delivery: markDead failed for binding "${hashId(entry.bindingKey)}"`, markError);
                    this.deps.log.debug(`delivery: markDead failed for binding "${entry.bindingKey}"`);
                }
            }
            this.deps.log.warn(`delivery: chat gone for "${entry.channel}:${hashId(entry.chat.chatId)}" — binding marked dead`);
            this.deps.log.debug(`delivery: chat gone for "${entry.channel}:${entry.chat.chatId}" — binding marked dead`);
            await this.markLedger(entry.id, "failed");
            this.deps.counts?.failed();
            return true;
        }
        if (kind === "permanent") {
            const fileDetail = error instanceof Error && error.name === FILE_RESOLUTION_ERROR
                ? ` (${error.message})`
                : "";
            this.deps.log.error(`delivery: permanent failure ("${entry.kind}" to "${hashId(entry.chat.chatId)}")${fileDetail}`, error);
            this.deps.log.debug(`delivery: permanent failure ("${entry.kind}" to "${entry.chat.chatId}")${fileDetail}`);
            await this.markLedger(entry.id, "failed");
            this.deps.counts?.failed();
            return true;
        }
        // Transient: the retry ladder. attempts was already incremented by
        // the attempting mark; a send is allowed delays.length + 1 tries
        // total (the initial attempt plus one per delay).
        const retriesUsed = entry.attempts;
        if (retriesUsed >= this.deps.delays.length) {
            this.deps.log.error(`delivery: retries exhausted ("${entry.kind}" to "${hashId(entry.chat.chatId)}"): ${detail}`);
            this.deps.log.debug(`delivery: retries exhausted ("${entry.kind}" to "${entry.chat.chatId}"): ${detail}`);
            await this.markLedger(entry.id, "failed");
            this.deps.counts?.failed();
            return true;
        }
        const delay = this.deps.delays[retriesUsed] ?? 0;
        this.deps.log.warn(`delivery: transient failure (attempt ${retriesUsed + 1}, retry in ${delay} ms): ${detail}`);
        // The entry returns to pending (the retry re-pulls it); the timer
        // re-kicks the loop. A stop cancels the timer — the entry stays
        // pending for the next boot's recovery.
        await this.markLedger(entry.id, "pending");
        if (this.stopped)
            return false;
        this.cancelRetry?.();
        this.cancelRetry = this.deps.setTimer(() => {
            this.cancelRetry = undefined;
            this.kick();
        }, delay);
        return false;
    }
    /** A ledger mark with its own error isolation (never throws). */
    async markLedger(id, state) {
        try {
            await this.ledger.mark(id, state);
        }
        catch (markError) {
            this.deps.log.error("delivery: ledger mark failed", markError);
        }
    }
    /**
     * The classification read (adapter's `classifyError` when present,
     * transient otherwise) with the timeout error forced transient.
     */
    classify(error) {
        if (error instanceof Error && (error.name === FILE_RESOLUTION_ERROR || error.name === EDIT_PRECONDITION_ERROR)) {
            return "permanent";
        }
        if (error instanceof Error &&
            error.name === "GatewaySendTimeout") {
            // Review Focus 2: a send over the bound is TRANSIENT — never
            // permanent, never chat_gone.
            return "transient";
        }
        if (this.channel.classifyError !== undefined) {
            return this.channel.classifyError(error);
        }
        return "transient";
    }
    /** The send-shaped message for one entry (the recovered marker rule). */
    async buildMessage(entry) {
        // An edit replaces its target; adding a resend prefix would corrupt
        // the already-final outcome text (the marker belongs on fresh sends).
        const text = entry.recovered === true && entry.kind !== "edit"
            ? `${RESENT_MARKER}\n${entry.message.text}`
            : entry.message.text;
        let files;
        if (entry.message.files !== undefined && this.deps.resolveFiles !== undefined) {
            try {
                files = await this.deps.resolveFiles(entry);
            }
            catch (error) {
                const paths = entry.message.files.map((file) => file.path).join(", ");
                this.deps.log.warn(`delivery: file resolution failed for ${paths}`);
                const failure = new Error(`file resolution failed for ${paths}`, {
                    cause: error,
                });
                failure.name = FILE_RESOLUTION_ERROR;
                throw failure;
            }
        }
        return {
            chat: entry.message.chat,
            text,
            ...(entry.message.replyTo === undefined
                ? {}
                : { replyTo: entry.message.replyTo }),
            ...(entry.message.buttons === undefined
                ? {}
                : { buttons: entry.message.buttons }),
            ...(files === undefined ? {} : { files }),
        };
    }
}
/** A workspace file no longer exists/readable; retrying cannot repair it. */
const FILE_RESOLUTION_ERROR = "GatewayFileResolutionError";
/** A structurally undeliverable edit can never succeed on retry. */
const EDIT_PRECONDITION_ERROR = "GatewayEditPreconditionError";
/** The timeout error's name (matched by `classify`, never instanceof). */
export const SEND_TIMEOUT_NAME = "GatewaySendTimeout";
/** Build the timeout error. */
function timeoutError(ms) {
    const error = new Error(`gateway: send exceeded ${ms} ms`);
    error.name = SEND_TIMEOUT_NAME;
    return error;
}
