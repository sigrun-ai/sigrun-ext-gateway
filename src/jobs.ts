/**
 * Job delivery targets (spec §8.8): a channel alone means the owner's
 * home DM; an explicit chat must be that home DM or a chat bound to a
 * conversation the owner can write. This policy gate is shared by job
 * delivery and the chat-facing message tools.
 */

import type { ChatRef, SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { BindingStore } from "./state/bindings.js";
import type { IdentityStore } from "./state/identities.js";

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/;

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
export function parseTarget(target: string): DeliveryTarget | undefined {
	const separator = target.indexOf(":");
	const channel = separator === -1 ? target : target.slice(0, separator);
	const chatId = separator === -1 ? undefined : target.slice(separator + 1);
	if (!CHANNEL_PATTERN.test(channel) || chatId === "") return undefined;
	return chatId === undefined ? { channel } : { channel, chatId };
}

/** Resolve and authorize each target independently; no target aborts the rest. */
export async function resolveTargets(
	deps: TargetDeps,
	owner: string,
	targets: readonly string[],
): Promise<ResolveTargetsResult> {
	const resolved: ResolvedTarget[] = [];
	const rejected: RejectedTarget[] = [];
	const homes = deps.identities.homesOf(owner);
	for (const target of targets) {
		const parsed = parseTarget(target);
		if (parsed === undefined) {
			rejected.push({ target, reason: "invalid target grammar" });
			continue;
		}
		const home = homes.find((entry) => entry.channel === parsed.channel);
		if (parsed.chatId === undefined) {
			if (home === undefined) {
				rejected.push({ target, reason: `no home chat on channel "${parsed.channel}"` });
			} else {
				resolved.push({ channel: parsed.channel, chat: home.chat });
			}
			continue;
		}
		if (home?.chat.chatId === parsed.chatId) {
			resolved.push({ channel: parsed.channel, chat: home.chat });
			continue;
		}
		const binding = findChatBinding(deps.bindings, parsed.channel, parsed.chatId);
		const meta = binding === undefined
			? undefined
			: await deps.host.conversations.meta(binding.conversationId as ConversationId);
		const access = meta === undefined
			? "none"
			: await deps.host.access.accessOf(
				{ user: owner },
				{ owner: meta.owner, sharing: meta.sharing },
			);
		if (binding === undefined || access !== "write") {
			rejected.push({ target, reason: "chat is not bound to a writable conversation" });
			continue;
		}
		resolved.push({ channel: parsed.channel, chat: binding.chat });
	}
	return { resolved, rejected };
}

/** Find a chat without guessing its thread id or group/DM type. */
function findChatBinding(
	bindings: BindingStore,
	channel: string,
	chatId: string,
): ReturnType<BindingStore["get"]> {
	const prefix = `${channel}:default:`;
	for (const key of bindings.allKeys()) {
		if (!key.startsWith(prefix)) continue;
		const binding = bindings.get(key);
		if (binding?.chat.chatId === chatId) return binding;
	}
	return undefined;
}
