/**
 * The gateway-channel prompt section (spec §8.10): bound-chat context,
 * group ownership warnings, anyone-group admission, and multi-binding text.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import type { ChannelContribution, ChatRef } from "@sigrun/sigrun/extension";
import { afterAll, describe, expect, test } from "vitest";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";
import { createChannelSection } from "../src/section.js";
import { parseGatewayConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const LOOP: ChannelContribution = {
	id: "loop",
	label: "Loop",
	capabilities: {
		chatTypes: ["dm", "group"],
		maxMessageLength: 200,
		format: "markdown",
		promptHint: "Loop renders markdown.",
	},
	configured: () => ({ status: "ready" }),
	start: async () => {},
	send: async () => ({ messageIds: [] }),
};

async function rig(settings: Record<string, unknown> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-section-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host: FakeHost = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice" }],
	});
	await host.stores.settings.set(settings);
	const bindings = new BindingStore(join(dir, "bindings.json"));
	const section = createChannelSection({
		host,
		bindings,
		channelOf: (id) => id === "loop" ? LOOP : undefined,
		readConfig: async () => parseGatewayConfig(await host.stores.settings.get()),
	});
	const render = (conversationId: number): Promise<string | undefined> =>
		Promise.resolve(section.render(
			{ conversationId } as PromptInput,
			BACKGROUND_CONTEXT,
		));
	const bind = async (conversationId: number, chat: ChatRef): Promise<void> => {
		await bindings.bind(bindingKey("loop", chat), conversationId, chat);
	};
	return { host, section, render, bind };
}

describe("gateway-channel", () => {
	test("renders a direct-message binding", async () => {
		const { section, render, bind } = await rig();
		expect(section.key).toBe("gateway-channel");
		await bind(1, { chatId: "100000001", chatType: "dm" });
		expect(await render(1)).toBe(
			"This conversation is connected to Loop (direct message). Loop renders markdown.",
		);
	});

	test("renders group sender and owner guidance", async () => {
		const { render, bind } = await rig({
			channels: {
				loop: {
					groups: [{ chat: "42", owner: "alice", members: "linked" }],
				},
			},
		});
		await bind(1, { chatId: "42", chatType: "group" });
		expect(await render(1)).toBe(
			"This conversation is connected to Loop (group \"42\"). Loop renders markdown.\n" +
			"Messages are prefixed with the sender's name. You act for alice; senders other than alice are not the account owner.",
		);
	});

	test("adds the anyone-group line", async () => {
		const { render, bind } = await rig({
			channels: {
				loop: {
					groups: [{ chat: "42", owner: "alice", members: "anyone", tools: ["send_message"] }],
				},
			},
		});
		await bind(1, { chatId: "42", chatType: "group" });
		expect(await render(1)).toContain("Anyone in the group can message you.");
	});

	test("renders the first binding and counts additional connected chats", async () => {
		const { render, bind } = await rig();
		await bind(1, { chatId: "100000001", chatType: "dm" });
		await bind(1, { chatId: "100000002", chatType: "dm" });
		expect(await render(1)).toBe(
			"This conversation is connected to Loop (direct message). Loop renders markdown. (also connected to 1 more)",
		);
	});

	test("returns undefined for an unbound conversation", async () => {
		const { render } = await rig();
		expect(await render(999)).toBeUndefined();
	});
});
