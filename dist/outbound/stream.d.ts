/**
 * Origin-chat streaming (spec §8.6): live frames ride the conversation
 * watch, never the durable ledger. The first send waits for 20 visible
 * characters; later edits are prefix-stable and rate-limited. Final
 * chunks come from runSettled, not from the last preview frame.
 */
import type { ChannelContribution, ChatRef, SigrunHost } from "@sigrun/sigrun/extension";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
import type { Streams } from "./settled.js";
export interface StreamOrigin {
    readonly channel: string;
    readonly bindingKey: string;
    readonly chat: ChatRef;
}
export interface StreamRegistryDeps {
    readonly host: SigrunHost;
    readonly channelOf: (id: string) => ChannelContribution | undefined;
    readonly configOf: (id: string) => Promise<ChannelConfig | undefined>;
    readonly log: EngineLog;
    readonly now?: () => number;
    readonly setTimer?: (fn: () => void, ms: number) => () => void;
}
export declare class StreamRegistry implements Streams {
    private readonly deps;
    private readonly now;
    private readonly setTimer;
    private readonly active;
    private readonly openings;
    constructor(deps: StreamRegistryDeps);
    open(conversationId: number, origin: StreamOrigin): Promise<boolean>;
    finalize(conversationId: number, chunks: string[]): Promise<boolean>;
    abandonAll(): void;
    abandon(conversationId: number): void;
    private startTyping;
    private preview;
    private edit;
}
