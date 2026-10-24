/**
 * Job delivery targets (spec §8.8): a channel alone means the owner's
 * home DM; an explicit chat must be that home DM or a chat bound to a
 * conversation the owner can write. This policy gate is shared by job
 * delivery and the chat-facing message tools.
 */
import type { ChatRef, SigrunHost } from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { IdentityStore } from "./state/identities.js";
export interface DeliveryTarget {
    readonly channel: string;
    readonly chatId?: string;
}
export interface ResolvedTarget {
    readonly channel: string;
    readonly chat: ChatRef;
}
export interface RejectedTarget {
    readonly target: string;
    readonly reason: string;
}
export interface ResolveTargetsResult {
    readonly resolved: readonly ResolvedTarget[];
    readonly rejected: readonly RejectedTarget[];
}
export interface TargetDeps {
    readonly host: SigrunHost;
    readonly bindings: BindingStore;
    readonly identities: IdentityStore;
}
/** Parse `<channel>` or `<channel>:<chatId>`; the chat id is opaque. */
export declare function parseTarget(target: string): DeliveryTarget | undefined;
/** Resolve and authorize each target independently; no target aborts the rest. */
export declare function resolveTargets(deps: TargetDeps, owner: string, targets: readonly string[]): Promise<ResolveTargetsResult>;
