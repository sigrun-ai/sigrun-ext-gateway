/**
 * The inbound pipeline (spec §8.4): one `receive` runs the ordered
 * steps. Task 3 implements steps 2 (dedupe), 3 (self/bot drops — the
 * bot loop guard's counting arrives with the group admission task),
 * 5 (allowlist/link DMs only; groups arrive with their own task), 6
 * (album merge) and 10 (submit) plus the M12 submit-error outcomes.
 * Steps 1 (claimed gate), 4 (self-link), 7 (commands), 8 (interaction
 * answers) and 9 (attachments) are INJECTABLE STAGES
 * (`PipelineDeps.stages`) filled by their own tasks — the design keeps
 * the step ORDER in one place while each task lands its logic.
 *
 * The channel's config is read LIVE per event by the CALLER (the
 * engine's `receive` wrapper reads `readConfig(host)` and passes the
 * channel's block in) — every field except `enabled` is per-event.
 *
 * On admission the pipeline records `submissionId → { bindingKey,
 * channel }` in `deps.origins` (the in-memory map the outbound tasks
 * consume — which chat a run came from, so settled answers route).
 *
 * The notice/error replies go through `deps.channel.send` — the
 * adapter-bound transport, host-independent (the loopback fixture's
 * `sent` array records them, which is how the sigrun e2e asserts reply
 * text). A failed notice send is logged, never thrown: the submit
 * error already resolved the event's fate.
 */
import type { ChannelContribution, InboundEvent, SigrunHost, SubmissionInputPart } from "@sigrun/sigrun/extension";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
/** A receive's terminal outcome (the adapter acks on any resolution). */
export type PipelineOutcome = {
    readonly outcome: "admitted";
} | {
    readonly outcome: "dropped";
} | {
    readonly outcome: "command";
};
/**
 * The origin record: which chat a submission came from. The outbound
 * tasks (streaming hand-off, unanswered notices) read it.
 */
export interface SubmissionOrigin {
    readonly bindingKey: string;
    readonly channel: string;
}
/** The stages later tasks inject (§8.4 steps 1, 4, 7, 8, 9). */
export interface PipelineStages {
    /** Step 1 (the claimed gate): true when setup is unclaimed (drop). */
    readonly claimedGate?: (channelId: string) => boolean;
    /**
     * Step 4 (self-link): handles `/link <code>`. Returns an outcome
     * when it consumed the event, undefined to continue the pipeline.
     */
    readonly selfLink?: (channelId: string, event: InboundEvent) => Promise<PipelineOutcome | undefined>;
    /**
     * Step 7 (commands): handles gateway chat commands (the bound
     * conversation id is handed in — commands act on it). Returns an
     * outcome when consumed, undefined to continue.
     */
    readonly command?: (channelId: string, event: InboundEvent, conversationId: number) => Promise<PipelineOutcome | undefined>;
    /** Step 8 (interaction text answers): consumed-or-continue, as above. */
    readonly interactionAnswer?: (channelId: string, event: InboundEvent) => Promise<PipelineOutcome | undefined>;
    /** Step 9 (attachments): render the event's media into submit parts. */
    readonly attachments?: (event: InboundEvent) => Promise<readonly SubmissionInputPart[]>;
}
/** The pipeline's injectable dependencies. */
export interface PipelineDeps {
    readonly host: SigrunHost;
    /** The channel adapter (send for notice replies; the label for names). */
    readonly channel: ChannelContribution;
    /** The engine's state dir (`<stateDir>/gateway`). */
    readonly stateDir: string;
    readonly log: EngineLog;
    /** submissionId → the origin record (the outbound seam). */
    readonly origins: Map<SubmissionId, SubmissionOrigin>;
    /** The injectable stages (§8.4 steps 1, 4, 7, 8, 9). */
    readonly stages?: PipelineStages;
    /** The clock (tests inject a fake). Default: real. */
    readonly now?: () => number;
}
/**
 * The engine's per-receive handler: `(channelId, event, config) →
 * outcome`. The config is the LIVE channel block (the caller read it
 * per event through `readConfig`).
 */
export type Receive = (channelId: string, event: InboundEvent, config: ChannelConfig) => Promise<PipelineOutcome>;
/**
 * A pipeline's receive, carrying the engine-owned flush handle: ONE
 * pipeline per engine (the state stores are shared across channels; the
 * binding key carries the channel) — the engine wires every supervised
 * channel's `ChannelContext.receive` through the callable and calls
 * `flushAlbums` from its `stopIntake`.
 */
export interface PipelineHandle extends Receive {
    /**
     * Close every open album window and submit its merged batch; the
     * engine's `stopIntake` runs this before intake closes (the §8.0
     * ordering: flush, then stop admitting).
     */
    flushAlbums(): Promise<void>;
}
export declare function createPipeline(deps: PipelineDeps): PipelineHandle;
