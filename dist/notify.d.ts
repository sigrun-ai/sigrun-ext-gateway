/**
 * The home-chat notifier (spec §8.8): core chooses the recipients; the
 * engine turns each event into durable ledger entries for that user's
 * home DMs. Handlers only enqueue — channel workers own platform I/O.
 */
import type { NotifierContribution, SigrunHost } from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { IdentityStore } from "./state/identities.js";
import type { Ledger } from "./state/ledger.js";
import type { GatewayConfig } from "./config.js";
import type { EngineLog } from "./log.js";
export interface NotifyDeps {
    readonly host: SigrunHost;
    readonly bindings: BindingStore;
    readonly identities: IdentityStore;
    readonly ledger: Ledger;
    readonly readConfig: () => Promise<GatewayConfig>;
    readonly log: EngineLog;
}
/** Build the factory-result notifier over the engine's shared stores. */
export declare function createNotifier(deps: NotifyDeps): NotifierContribution;
