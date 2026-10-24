/**
 * Chat commands (spec §8.5): the gateway's reserved slash commands plus
 * non-colliding extension commands. They run inline at inbound stage 7,
 * before the busy submission queue, and every operation acts on the
 * chat's current binding.
 *
 * Unknown slash text is NOT consumed: prompt templates and skill
 * expansion still belong to ordinary submission admission. `/link` and
 * `/pair` are the authorization exceptions — linking needs no existing
 * conversation access, and pairing applies its own effective-admin
 * check. Every other command first proves write access to the bound
 * conversation; `/attach` then separately proves write access to its
 * target before changing the binding.
 */
import type { ChannelContribution, InboundEvent, SigrunHost } from "@sigrun/sigrun/extension";
import type { Binding, BindingStore } from "../state/bindings.js";
import type { IdentityStore } from "../state/identities.js";
import type { PairingStore } from "../access/pairing.js";
import type { LinkCodes } from "../access/link-codes.js";
import type { GroupConfig } from "../config.js";
import type { EngineLog } from "../log.js";
/** One gateway chat command's native-menu metadata and placement rule. */
export interface GatewayCommand {
    readonly name: string;
    readonly description: string;
    readonly where: "any" | "dm" | "not-anyone-group";
    readonly admin?: true;
}
/** The reserved command table, in spec §8.5 order. */
export declare const GATEWAY_COMMANDS: readonly GatewayCommand[];
/** The shared stores and host surfaces the command handlers use. */
export interface ChatCommandDeps {
    readonly host: SigrunHost;
    readonly channel: ChannelContribution;
    readonly bindings: BindingStore;
    readonly identities: IdentityStore;
    readonly pairing: PairingStore;
    readonly linkCodes: LinkCodes;
    readonly streams?: {
        abandon(conversationId: number): void;
    };
    readonly channelOf: (channel: string) => ChannelContribution | undefined;
    readonly log: EngineLog;
    readonly now: () => number;
}
/** The admission context for one possible command. */
export interface ChatCommandContext {
    readonly channel: string;
    readonly event: InboundEvent;
    readonly bindingKey: string;
    readonly user: string | undefined;
    readonly binding?: Binding;
    readonly group?: GroupConfig;
    /** Stage 4 owns redemption when enabled; stage 7 must refuse when disabled. */
    readonly selfLink: boolean;
}
/** The native menu: reserved commands plus non-colliding extension rows. */
export declare function chatCommandMenu(host: SigrunHost): Promise<readonly {
    readonly name: string;
    readonly description: string;
}[]>;
/**
 * Consume one gateway/extension command, or return `"not-a-command"`
 * so admission continues with the original text.
 */
export declare function handleChatCommand(deps: ChatCommandDeps, ctx: ChatCommandContext): Promise<"command" | "not-a-command">;
