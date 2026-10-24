/**
 * The chat-facing agent tools (spec §8.9). Policy failures are ordinary
 * error results, never exceptions. Sends persist to the delivery ledger
 * before waiting for a receipt, so a timeout leaves honest queued work.
 */
import { type ToolRegistration } from "@earendil-works/pi-durable";
import type { ChannelContribution, SigrunHost } from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { IdentityStore } from "./state/identities.js";
import type { Ledger } from "./state/ledger.js";
import type { GatewayConfig } from "./config.js";
import type { EngineLog } from "./log.js";
export declare const RECEIPT_WAIT_MS = 30000;
export interface ToolDeps {
    readonly host: SigrunHost;
    readonly bindings: BindingStore;
    readonly identities: IdentityStore;
    readonly ledger: Ledger;
    channelOf(channel: string): ChannelContribution | undefined;
    readConfig(): Promise<GatewayConfig>;
    readonly log: EngineLog;
    /** Poke the channel's worker after enqueueing. */
    readonly kick?: () => void;
    readonly receiptWaitMs?: number;
}
/** Build both tools over the engine's shared state. */
export declare function createGatewayTools(deps: ToolDeps): readonly ToolRegistration[];
