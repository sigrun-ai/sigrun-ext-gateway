/**
 * onRunSettled (spec §8.6's "which runs deliver" + the M7 access
 * re-check): the engine's `runSettled` factory handler. ONLY ENQUEUES —
 * the per-channel delivery workers own the platform calls.
 *
 * - Every key in `bindings.keysOf(conversationId)` that is not dead
 *   gets a final (whoever started the run — ruling 4: a webui submit
 *   into a bound conversation delivers to the chat).
 * - Access is RE-CHECKED per delivery (M7): `meta` + `accessOf` for
 *   the binding's user — the LINKED user for DMs, the group owner for
 *   groups. A failed check UNBINDS the chat, logs it, and enqueues
 *   nothing.
 * - An answered run renders the answer's text blocks (thinking and
 *   tool calls are never shown); an answer with NO text blocks gets
 *   the pinned "(no text reply)" notice (Review Focus 4 — an empty
 *   send is a platform rejection, never an honest reply).
 * - The origin-chat streaming hand-off is Task 6's seam
 *   (`deps.streams.finalize`, a no-op stub returning false here);
 *   when the stream owns delivery, no final entries enqueue.
 * - An unanswered run notifies the ORIGIN chat only (from
 *   `deps.origins`): the pinned "Stopped." for an abort reason, a
 *   short reason notice otherwise.
 */
import type { ChannelContribution, RunSettledEvent, SigrunHost } from "@sigrun/sigrun/extension";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ChannelConfig } from "../config.js";
import type { BindingStore } from "../state/bindings.js";
import type { Ledger } from "../state/ledger.js";
import type { EngineLog } from "../log.js";
import type { IdentityStore } from "../state/identities.js";
import type { SubmissionOrigin } from "../inbound/pipeline.js";
/** The pinned notice for a textless answer (Review Focus 4). */
export declare const NO_TEXT_REPLY = "(no text reply)";
/** The pinned abort notice (spec §8.6: "An abort from /stop produces Stopped."). */
export declare const STOPPED = "Stopped.";
/**
 * The streaming hand-off seam (Task 6). `finalize` answers ONE
 * question: did the stream own this conversation's origin-chat
 * delivery? True → the settled path skips the origin chat's finals
 * (the stream already delivered them); the rest of the fan-out still
 * enqueues. Chunks are NOT passed here: rendering is channel-shaped
 * and happens per key inside the fan-out — Task 6's StreamRegistry
 * owns its own `finalize(conversationId, chunks)` shape at its layer
 * and answers through this seam (the engine's stub wires the answer
 * into the fan-out decision).
 */
export interface Streams {
    finalize(conversationId: number): Promise<boolean>;
}
/** onRunSettled's injectable dependencies. */
export interface SettledDeps {
    readonly host: SigrunHost;
    /** The engine-wide bindings (the delivery fan-out read). */
    readonly bindings: BindingStore;
    /** The engine-wide identity links (the binding's user resolution). */
    readonly identities: IdentityStore;
    /** The ledger the finals enqueue into. */
    readonly ledger: Ledger;
    /** The channel id → adapter lookup (the render step's caps/format). */
    readonly channelOf: (id: string) => ChannelContribution | undefined;
    /** The live channel configs (the group owner read). */
    readonly configOf: (id: string) => Promise<ChannelConfig | undefined>;
    /** submissionId → the origin record (the unanswered notice's target). */
    readonly origins: Map<SubmissionId, SubmissionOrigin>;
    /** The Task 6 streaming seam (the stub here). */
    readonly streams: Streams;
    readonly log: EngineLog;
}
/**
 * The settled-run handler: enqueue finals (or the empty-answer notice)
 * for every live bound chat, and the unanswered notice for the origin
 * chat. Never throws (the event bus's bounded handler owns isolation,
 * but a ledger failure must not lose the rest of the fan-out).
 */
export declare function onRunSettled(event: RunSettledEvent, deps: SettledDeps): Promise<void>;
