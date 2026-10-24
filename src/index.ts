/**
 * sigrun-ext-gateway: the gateway engine factory (the loader contract).
 *
 * The sigrun extension-package contract: the default export is a factory
 * DECLARING the host parameter (arity 1 — the host rule; a length-0
 * factory with a defaulted first parameter would consume the host as
 * that dependency), returning `{ extension, gateway, routes,
 * commands }`.
 *
 * The extension is a bare `defineExtension({ name: "gateway" })`:
 * the prompt section (§8.10) and the `send_message`/`list_chats` tools
 * (§8.9) land with the tasks that own them. The `gateway` engine is
 * built over the host at factory time (cheap closure wiring — no
 * timers, no I/O; the pi lifecycle rule: the factory registers
 * handlers only, `start` runs after the server listens), the admin
 * status route (Task 2, §8.12) renders the engine's status read, and
 * the `/pair` + `/link` slash commands (Task 4, §8.2) close over the
 * SAME engine-wide access state the pipelines use — a webui approval
 * and a chat-button tap drive the same pairing queue, and an issued
 * link code redeems in the matching channel's pipeline.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import type {
	ExtensionCommandContribution,
	SigrunHost,
	SigrunExtensionResult,
} from "@sigrun/sigrun/extension";
import { createEngine } from "./engine.js";
import { createStatusRoute } from "./status-route.js";
import { runPair } from "./commands/pair.js";
import { createLinkCommand } from "./commands/link.js";
import { readConfig } from "./config.js";
import { createGatewayTools } from "./tools.js";
import { createChannelSection } from "./section.js";

/**
 * The sigrun extension-package factory: builds the engine over the host.
 * One factory call, one engine (the one-engine rule holds at the loader:
 * a second declarer quarantines).
 */
export default function createGateway(host: SigrunHost): SigrunExtensionResult {
	const engine = createEngine(host);
	// `/pair` (§8.2): the admin surface over the shared pairing queue.
	// The invoke route hands the caller's principal (user + EFFECTIVE
	// admin — the stored flag OR the persisted group grant, C8); an
	// unnamed loopback caller gets the pinned refusal.
	const pair: ExtensionCommandContribution = {
		name: "pair",
		description: "Manage pending channel pairing requests (admin)",
		args: "[approve <code> <user> | deny <code>]",
		run: async (ctx) => ({
			notice: await runPair(engine.pairDeps(host), ctx.args, {
				user: ctx.principal.user,
				admin: ctx.principal.admin,
			}),
		}),
	};
	// `/link <channel>` (§8.2): issue a single-use self-link code bound
	// to the invoking user and channel. `knownChannels` reads the ids the
	// last start recorded — an engine that never started knows none, and
	// every channel id is unknown (the honest refusal).
	const link: ExtensionCommandContribution = createLinkCommand({
		readConfig: () => readConfig(host),
		linkCodes: engine.accessState().linkCodes,
		knownChannels: engine.channelIds,
		now: Date.now,
	});
	return {
		extension: defineExtension({
			name: "gateway",
			tools: createGatewayTools(engine.toolDeps()),
			sections: [createChannelSection(engine.sectionDeps())],
		}),
		gateway: engine,
		// The settled-run fan-out (§8.6): boot registers this on the event
		// bus — one call per settled run, which enqueues the finals and
		// kicks the workers. The narrowed document read is mandatory:
		// unlike the host bridge, it resolves in harness-only embedders
		// without a 30 s wait.
		runSettled: (event, api, context) => engine.settle(event, api, context),
		// Home-chat notifications share the delivery ledger and workers;
		// this wrapper kicks delivery after each bounded enqueue.
		notifiers: [engine.notifier()],
		// The admin status route (§8.12): mounts at /v1/ext/gateway/status,
		// admin-gated by core's route mounting (the handler renders the
		// engine's read; `pairing` rows carry the hashed sender id, never
		// the code).
		routes: [
			createStatusRoute(() => ({
				channels: engine.status().channels,
				pairing: engine.pairingStatus(),
			})),
		],
		commands: [pair, link],
	};
}

export { createEngine } from "./engine.js";
export { collectAttachments, TOO_LARGE_NOTE, VOICE_NOTE, ATTACHMENT_FAILED_NOTE } from "./inbound/media.js";
export type { MediaDeps, CollectedAttachments } from "./inbound/media.js";
export { createGatewayTools, RECEIPT_WAIT_MS } from "./tools.js";
export type { ToolDeps } from "./tools.js";
export { createChannelSection } from "./section.js";
export type { ChannelSectionDeps } from "./section.js";
export type { EngineDeps, EngineInternals } from "./engine.js";
export { splitMarkdown, stripMarkdown } from "./outbound/markdown.js";
export { renderChunks } from "./outbound/render.js";
export type { SerializedOutbound, LedgerEntry, LedgerInput, LedgerKind, LedgerState } from "./state/ledger.js";
export { Ledger, PRUNE_AFTER_MS } from "./state/ledger.js";
export { DeliveryWorker, RESENT_MARKER } from "./outbound/delivery.js";
export type { DeliveryDeps } from "./outbound/delivery.js";
export { onRunSettled, NO_TEXT_REPLY, STOPPED } from "./outbound/settled.js";
export { parseTarget, resolveTargets } from "./jobs.js";
export type {
	DeliveryTarget,
	RejectedTarget,
	ResolvedTarget,
	ResolveTargetsResult,
	TargetDeps,
} from "./jobs.js";
export { createNotifier } from "./notify.js";
export type { NotifyDeps } from "./notify.js";
export type { SettledDeps, Streams } from "./outbound/settled.js";
export { StreamRegistry } from "./outbound/stream.js";
export type { StreamOrigin, StreamRegistryDeps } from "./outbound/stream.js";
export { Supervisor } from "./supervisor.js";
export type {
	ChannelState,
	ChannelStatus,
	StatusSink,
	SupervisorDeps,
} from "./supervisor.js";
export { createStatusRoute } from "./status-route.js";
export type {
	GatewayStatus,
	StatusPairingRow,
	StatusRead,
} from "./status-route.js";
export {
	parseGatewayConfig,
	readConfig,
	DEFAULT_MEDIA_MAX_BYTES,
} from "./config.js";
export type {
	ChannelConfig,
	DmPolicy,
	GatewayConfig,
	GroupConfig,
} from "./config.js";
export { JsonFile } from "./state/json-file.js";
export { bindingKey, BindingStore } from "./state/bindings.js";
export type { Binding } from "./state/bindings.js";
export { SeenSet } from "./state/seen.js";
export { IdentityStore } from "./state/identities.js";
export type { LinkVia, ResolvedUser } from "./state/identities.js";
export { buildEnvelope } from "./inbound/envelope.js";
export { createPipeline } from "./inbound/pipeline.js";
export type {
	AccessState,
	PipelineDeps,
	PipelineOutcome,
	PipelineStreams,
	PipelineStages,
	Receive,
	SubmissionOrigin,
} from "./inbound/pipeline.js";
export { AlbumCollector, ALBUM_WINDOW_MS } from "./inbound/albums.js";
export { ButtonTokens } from "./inbound/tokens.js";
export type { TokenAction } from "./inbound/tokens.js";
export { CODE_ALPHABET, newCode, normalizeCode } from "./access/codes.js";
export { PairingStore, PAIRING_TTL_MS } from "./access/pairing.js";
export type { PairingRequest, RequestResult } from "./access/pairing.js";
export { LinkCodes } from "./access/link-codes.js";
export { LoopGuard } from "./access/loop-guard.js";
export { runPair } from "./commands/pair.js";
export type { PairCaller, PairDeps } from "./commands/pair.js";
export { createLinkCommand, redeemLink } from "./commands/link.js";
export {
	GATEWAY_COMMANDS,
	chatCommandMenu,
	handleChatCommand,
} from "./commands/chat.js";
export type {
	ChatCommandContext,
	ChatCommandDeps,
	GatewayCommand,
} from "./commands/chat.js";
export type {
	LinkCommand,
	LinkCommandDeps,
	LinkDeps,
} from "./commands/link.js";
export { createLog, hashId } from "./log.js";
export type { EngineLog } from "./log.js";
