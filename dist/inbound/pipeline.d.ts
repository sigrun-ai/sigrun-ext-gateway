/**
 * The inbound pipeline (spec §8.4): one `receive` runs the ordered
 * steps. Task 3 landed steps 2 (dedupe), 3 (self/bot drops), 6 (album
 * merge) and 10 (submit) plus the M12 submit-error outcomes; Task 4
 * fills step 1 (the claimed gate), step 4 (self-link) and step 5 (the
 * DM access policies) INLINE over the shared {@link AccessState} — the
 * access stores are engine-wide (one pairing queue, one link-code
 * table, one token table, one loop guard), so the engine builds the
 * state and hands it to every channel's pipeline. Steps 7 (commands),
 * 8 (interaction answers) and 9 (attachments) remain INJECTABLE STAGES
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
import type { ActionEvent, ChannelContribution, InboundEvent, SigrunHost } from "@sigrun/sigrun/extension";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
import type { StreamOrigin } from "../outbound/stream.js";
import { BindingStore } from "../state/bindings.js";
import { IdentityStore } from "../state/identities.js";
import { PairingStore } from "../access/pairing.js";
import { LinkCodes } from "../access/link-codes.js";
import { LoopGuard } from "../access/loop-guard.js";
import { ButtonTokens } from "./tokens.js";
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
export interface SubmissionOrigin extends StreamOrigin {
}
/**
 * The engine-wide access state (Task 4): every store the access steps
 * and the pair/link commands share. The ENGINE builds one and threads
 * it into every channel pipeline AND the command closures; a pipeline
 * constructed WITHOUT one builds a private state over its own state
 * dir (the stand-alone Task 3 shape).
 */
export interface AccessState {
    readonly identities: IdentityStore;
    readonly pairing: PairingStore;
    readonly linkCodes: LinkCodes;
    readonly tokens: ButtonTokens;
    readonly loopGuard: LoopGuard;
}
/** The stages later tasks inject (§8.4 steps 8, 9). */
export interface PipelineStages {
    /** Step 8 (interaction text answers): consumed-or-continue, as above. */
    readonly interactionAnswer?: (channelId: string, event: InboundEvent) => Promise<PipelineOutcome | undefined>;
    /** Step 9 (attachments): render the event's media into submit parts. */
    readonly attachments?: (event: InboundEvent) => Promise<import("./media.js").CollectedAttachments>;
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
    /** The engine-wide binding store (the settled fan-out and the
     *  delivery workers share this ONE instance — cross-instance writes
     *  would interleave JsonFile queues and lose updates). Absent → a
     *  private instance (the stand-alone Task 3 shape). */
    readonly bindings?: BindingStore;
    /** The injectable stages (§8.4 steps 8, 9). */
    readonly stages?: PipelineStages;
    /** Cross-channel lookup for `/pair` approval notices. Stand-alone
     *  pipelines fall back to their own adapter. */
    readonly channelOf?: (channel: string) => ChannelContribution | undefined;
    /** The engine-wide access state (Task 4). Absent → a private one. */
    readonly access?: AccessState;
    /** The origin-chat stream registry (Task 6). Absent in stand-alone
     *  pipeline tests disables streaming; the engine always wires it. */
    readonly streams?: PipelineStreams;
    /** The clock (tests inject a fake). Default: real. */
    readonly now?: () => number;
}
/** The pipeline's narrow stream seam; StreamRegistry and test fakes fit it. */
export interface PipelineStreams {
    open(conversationId: number, origin: StreamOrigin): Promise<boolean>;
    abandon(conversationId: number): void;
}
/**
 * The engine's per-receive handler: `(channelId, event, config) →
 * outcome`. The config is the LIVE channel block (the caller read it
 * per event through `readConfig`).
 */
export type Receive = (channelId: string, event: InboundEvent, config: ChannelConfig) => Promise<PipelineOutcome>;
/**
 * A pipeline's receive, carrying the engine-owned flush handle and the
 * tap handler: ONE pipeline per engine (the state stores are shared
 * across channels; the binding key carries the channel) — the engine
 * wires every supervised channel's `ChannelContext.receive` through
 * the callable, calls `flushAlbums` from its `stopIntake`, and routes
 * `ChannelContext.action` through `action`.
 */
export interface PipelineHandle extends Receive {
    /**
     * Close every open album window and submit its merged batch; the
     * engine's `stopIntake` runs this before intake closes (the §8.0
     * ordering: flush, then stop admitting).
     */
    flushAlbums(): Promise<void>;
    /**
     * A button tap (§8.7): resolve the token, guard the tapper (a pair
     * decision needs an EFFECTIVE admin — C8), apply the decision.
     * Foreign or replayed tokens are ignored; a tap never throws across
     * the adapter boundary.
     */
    action(channelId: string, event: ActionEvent, config: ChannelConfig): Promise<void>;
}
export declare function createPipeline(deps: PipelineDeps): PipelineHandle;
