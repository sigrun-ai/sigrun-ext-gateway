/**
 * The bound-chat prompt section (spec §8.10). It describes only the
 * first live binding, keeping its text static per binding for prompt-cache
 * stability; additional bindings collapse to the pinned count suffix.
 */

import { section, type PromptSection } from "@earendil-works/pi-durable";
import type { ChannelContribution, ChatRef, SigrunHost } from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { GatewayConfig, GroupConfig } from "./config.js";

export interface ChannelSectionDeps {
	readonly host: SigrunHost;
	readonly bindings: BindingStore;
	channelOf(channel: string): ChannelContribution | undefined;
	readConfig(): Promise<GatewayConfig>;
}

export function createChannelSection(deps: ChannelSectionDeps): PromptSection {
	return section("gateway-channel", async (input) => {
		const keys = deps.bindings.keysOf(input.conversationId as number).filter(
			(key) => deps.bindings.get(key)?.dead !== true,
		);
		const first = keys[0];
		if (first === undefined) return undefined;
		const binding = deps.bindings.get(first);
		if (binding === undefined) return undefined;
		const channelId = first.split(":", 1)[0];
		if (channelId === undefined) return undefined;
		const channel = deps.channelOf(channelId);
		if (channel === undefined) return undefined;
		const config = await deps.readConfig();
		const block = config.channels[channelId];
		const group = block === undefined || "failed" in block
			? undefined
			: findGroup(block.groups, binding.chat);
		const title = (binding.chat as ChatRef & { readonly title?: string }).title;
		const chatLabel = binding.chat.chatType === "dm"
			? "direct message"
			: `group "${title ?? binding.chat.chatId}"`;
		const hint = channel.capabilities.promptHint;
		const lines = [
			`This conversation is connected to ${channel.label} (${chatLabel}).${hint === undefined ? "" : ` ${hint}`}`,
		];
		if (binding.chat.chatType !== "dm") {
			const owner = group === undefined
				? (await deps.host.conversations.meta(input.conversationId)).owner
				: group.owner;
			if (owner !== undefined) {
				const ownerName = (await deps.host.users.get(owner))?.name ?? owner;
				lines.push(
					`Messages are prefixed with the sender's name. You act for ${ownerName}; senders other than ${ownerName} are not the account owner.`,
				);
			}
			if (group?.members === "anyone") {
				lines.push("Anyone in the group can message you.");
			}
		}
		let rendered = lines.join("\n");
		if (keys.length > 1) rendered += ` (also connected to ${keys.length - 1} more)`;
		return rendered;
	});
}

function findGroup(
	groups: readonly (GroupConfig | { readonly chat: string; readonly failed: string })[],
	chat: ChatRef,
): GroupConfig | undefined {
	return groups.find((group): group is GroupConfig =>
		!("failed" in group) && group.chat === chat.chatId
	);
}
