/**
 * The bound-chat prompt section (spec §8.10). It describes only the
 * first live binding, keeping its text static per binding for prompt-cache
 * stability; additional bindings collapse to the pinned count suffix.
 */
import { type PromptSection } from "@earendil-works/pi-durable";
import type { ChannelContribution, SigrunHost } from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { GatewayConfig } from "./config.js";
export interface ChannelSectionDeps {
    readonly host: SigrunHost;
    readonly bindings: BindingStore;
    channelOf(channel: string): ChannelContribution | undefined;
    readConfig(): Promise<GatewayConfig>;
}
export declare function createChannelSection(deps: ChannelSectionDeps): PromptSection;
