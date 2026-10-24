/**
 * sigrun-ext-gateway: the gateway engine factory (the loader contract).
 *
 * The sigrun extension-package contract: the default export is a factory
 * DECLARING the host parameter (arity 1 — the host rule; a length-0
 * factory with a defaulted first parameter would consume the host as
 * that dependency), returning `{ extension, gateway }`.
 *
 * The extension is a bare `defineExtension({ name: "gateway" })`:
 * the prompt section (§8.10) and the `send_message`/`list_chats` tools
 * (§8.9) land with the tasks that own them. The `gateway` engine is
 * built over the host at factory time (cheap closure wiring — no
 * timers, no I/O; the pi lifecycle rule: the factory registers
 * handlers only, `start` runs after the server listens) and the
 * admin status route (Task 2, §8.12) renders the engine's status
 * read.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import type { SigrunHost, SigrunExtensionResult } from "@sigrun/sigrun/extension";
import { createEngine } from "./engine.js";
import { createStatusRoute } from "./status-route.js";

/**
 * The sigrun extension-package factory: builds the engine over the host.
 * One factory call, one engine (the one-engine rule holds at the loader:
 * a second declarer quarantines).
 */
export default function createGateway(host: SigrunHost): SigrunExtensionResult {
	const engine = createEngine(host);
	return {
		extension: defineExtension({ name: "gateway" }),
		gateway: engine,
		// The admin status route (§8.12): mounts at /v1/ext/gateway/status,
		// admin-gated by core's route mounting (the handler renders the
		// engine's read; `pairing` ships empty until Task 4).
		routes: [createStatusRoute(() => ({
			channels: engine.status().channels,
			pairing: [],
		}))],
	};
}

export { createEngine } from "./engine.js";
export type { EngineDeps, EngineInternals } from "./engine.js";
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
	PipelineDeps,
	PipelineOutcome,
	PipelineStages,
	Receive,
	SubmissionOrigin,
} from "./inbound/pipeline.js";
export { AlbumCollector, ALBUM_WINDOW_MS } from "./inbound/albums.js";
export { createLog, hashId } from "./log.js";
export type { EngineLog } from "./log.js";
