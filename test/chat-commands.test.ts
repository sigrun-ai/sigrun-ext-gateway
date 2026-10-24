/**
 * Chat commands (Task 7, spec §8.5): parsing and mention stripping,
 * where/access refusals, extension dispatch, command behaviors, and the
 * native menu installed at engine start. Tests own their literals.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	ChannelContribution,
	ChatRef,
	InboundEvent,
	OutboundMessage,
} from "@sigrun/sigrun/extension";
import type { ConversationViewWire } from "@sigrun/shared/views";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import {
	GATEWAY_COMMANDS,
	handleChatCommand,
} from "../src/commands/chat.js";
import { BindingStore, bindingKey, type Binding } from "../src/state/bindings.js";
import { IdentityStore } from "../src/state/identities.js";
import { PairingStore } from "../src/access/pairing.js";
import { LinkCodes } from "../src/access/link-codes.js";
import type { GroupConfig } from "../src/config.js";
import { createEngine } from "../src/engine.js";
import type { EngineLog } from "../src/log.js";

const CHAT: ChatRef = { chatId: "100000001", chatType: "dm" };
const KEY = bindingKey("loop", CHAT);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function log(): EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

interface Rig {
	readonly host: FakeHost;
	readonly channel: ChannelContribution;
	readonly sent: OutboundMessage[];
	readonly bindings: BindingStore;
	readonly identities: IdentityStore;
	readonly binding: Binding;
	readonly conversationId: number;
	readonly deps: Parameters<typeof handleChatCommand>[0];
	run(text: string, over?: {
		readonly user?: string;
		readonly chat?: ChatRef;
		readonly binding?: Binding;
		readonly group?: GroupConfig;
	}): Promise<"command" | "not-a-command">;
}

async function rig(owner = "alice"): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-chat-commands-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice", admin: true }, { user: "bob" }],
	});
	const sent: OutboundMessage[] = [];
	const channel: ChannelContribution = {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm", "group", "thread"],
			maxMessageLength: 200,
			format: "markdown",
		},
		configured: () => ({ status: "ready" }),
		start: async () => {},
		send: async (message) => {
			sent.push(message);
			return { messageIds: [`loop-${sent.length}`] };
		},
	};
	const bindings = new BindingStore(join(dir, "bindings.json"));
	const identities = new IdentityStore(join(dir, "identities.json"));
	const pairing = new PairingStore(join(dir, "pairing.json"));
	const linkCodes = new LinkCodes();
	const conversationId = (await host.conversations.create({
		owner,
		name: "Loop DM",
		source: "gateway",
	})) as number;
	await bindings.bind(KEY, conversationId, CHAT);
	const binding = bindings.get(KEY);
	if (binding === undefined) throw new Error("test binding was not stored");
	const deps: Parameters<typeof handleChatCommand>[0] = {
		host,
		channel,
		bindings,
		identities,
		pairing,
		linkCodes,
		channelOf: (id) => id === "loop" ? channel : undefined,
		log: log(),
		now: () => 1_000,
	};
	return {
		host,
		channel,
		sent,
		bindings,
		identities,
		binding,
		conversationId,
		deps,
		run: async (text, over = {}) => {
			const chat = over.chat ?? CHAT;
			const event: InboundEvent = {
				messageId: `message-${text}`,
				chat,
				sender: { id: "100000001", name: "Alice" },
				text,
			};
			return handleChatCommand(deps, {
				channel: "loop",
				event,
				bindingKey: bindingKey("loop", chat),
				user: over.user === undefined ? "alice" : over.user,
				binding: over.binding ?? binding,
				selfLink: false,
				...(over.group === undefined ? {} : { group: over.group }),
			});
		},
	};
}

function view(busy: boolean, queued = 0): ConversationViewWire {
	return {
		conversation: { id: 1 },
		entries: [],
		steer: { busy, queued },
		docs: {
			"pi.agent": {
				model: { provider: "faux", modelId: "m" },
				thinkingLevel: "medium",
			},
			...(busy ? { "pi.live": { run: { id: "run-1" } } } : {}),
			...(queued > 0
				? { "pi.inbox": { items: Array.from({ length: queued }, () => ({})) } }
				: {}),
		},
	};
}

function installViews(host: FakeHost, initial: ConversationViewWire): void {
	host.conversations.watch = (async (id, listener) => {
		listener({ ...initial, conversation: { id } });
		return async () => {};
	}) as typeof host.conversations.watch;
}

describe("chat command parsing and authorization", () => {
	test("the gateway table carries the spec names, where rules, and pair admin flag", () => {
		expect(GATEWAY_COMMANDS.map((command) => [
			command.name,
			command.where,
			command.admin,
		])).toEqual([
			["new", "any", undefined],
			["stop", "any", undefined],
			["model", "any", undefined],
			["thinking", "any", undefined],
			["compact", "any", undefined],
			["attach", "not-anyone-group", undefined],
			["status", "any", undefined],
			["home", "dm", undefined],
			["link", "dm", undefined],
			["pair", "dm", true],
			["help", "any", undefined],
		]);
	});

	test("/model@MyBot foo/bar strips the bot suffix and configures the remaining args", async () => {
		const harness = await rig();
		expect(await harness.run("/model@MyBot foo/bar")).toBe("command");
		const configure = harness.host.calls.find(
			(call) => call.method === "conversations.configure",
		);
		expect(configure?.args).toEqual([harness.conversationId, { model: "foo/bar" }]);
	});

	test("/home in a group is refused without moving a home", async () => {
		const harness = await rig();
		const group: GroupConfig = {
			chat: "200000001",
			owner: "alice",
			mention: "always",
			members: "linked",
		};
		expect(await harness.run("/home", {
			chat: { chatId: "200000001", chatType: "group" },
			group,
		})).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("send this in a direct message");
		expect(harness.identities.homesOf("alice")).toEqual([]);
	});

	test("/attach in an anyone group is refused without rebinding", async () => {
		const harness = await rig();
		const group: GroupConfig = {
			chat: "200000001",
			owner: "alice",
			mention: "always",
			members: "anyone",
		};
		expect(await harness.run("/attach 99", { group })).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("/attach is not available in this group.");
		expect(harness.bindings.get(KEY)?.conversationId).toBe(harness.conversationId);
	});

	test("an unknown /foo name falls through as text", async () => {
		const harness = await rig();
		expect(await harness.run("/foo some args")).toBe("not-a-command");
		expect(harness.sent).toEqual([]);
	});

	test("an extension command runs with the mapped user and returns its notice", async () => {
		const harness = await rig();
		harness.host.commands.list = async () => [
			{ name: "deploy", description: "Deploy the fixture", extension: "fixture" },
		];
		const runs: unknown[][] = [];
		harness.host.commands.run = async (...args) => {
			runs.push([...args]);
			return { notice: "Deployment queued." };
		};
		expect(await harness.run("/deploy blue green")).toBe("command");
		expect(runs).toEqual([[harness.conversationId, "deploy", "blue green", { user: "alice" }]]);
		expect(harness.sent.at(-1)?.text).toBe("Deployment queued.");
	});

	test("a sender without write access is refused before the command runs", async () => {
		const harness = await rig("bob");
		expect(await harness.run("/compact")).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("You do not have write access to this conversation.");
		expect(harness.host.calls.some((call) => call.method === "conversations.compact")).toBe(false);
	});
});

describe("chat command behaviors", () => {
	test("/new creates and rebinds, preserving the old id in previous", async () => {
		const harness = await rig();
		expect(await harness.run("/new")).toBe("command");
		const rebound = harness.bindings.get(KEY);
		expect(rebound?.conversationId).not.toBe(harness.conversationId);
		expect(rebound?.previous).toEqual([harness.conversationId]);
		expect(harness.sent.at(-1)?.text).toContain(String(rebound?.conversationId));
	});

	test("/stop aborts a live run silently and reports an idle run", async () => {
		const harness = await rig();
		let busy = true;
		harness.host.conversations.watch = (async (id, listener) => {
			listener(view(busy));
			return async () => {};
		}) as typeof harness.host.conversations.watch;
		expect(await harness.run("/stop")).toBe("command");
		expect(harness.sent).toEqual([]);
		expect(harness.host.calls.some((call) => call.method === "conversations.abort")).toBe(true);
		busy = false;
		expect(await harness.run("/stop")).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("Nothing is running.");
	});

	test("/stop also aborts queued work silently", async () => {
		const harness = await rig();
		installViews(harness.host, view(false, 1));
		expect(await harness.run("/stop")).toBe("command");
		expect(harness.sent).toEqual([]);
		expect(harness.host.calls.some((call) => call.method === "conversations.abort")).toBe(true);
	});

	test("/model without args shows the current model and one served model per line", async () => {
		const harness = await rig();
		installViews(harness.host, view(false));
		expect(await harness.run("/model")).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("Current model: faux/m\nfaux/m");
	});

	test("/thinking configures a level and /compact admits compaction", async () => {
		const harness = await rig();
		await harness.run("/thinking high");
		expect(harness.host.calls.find(
			(call) => call.method === "conversations.configure",
		)?.args).toEqual([harness.conversationId, { thinking: "high" }]);
		await harness.run("/compact");
		expect(harness.host.calls.some((call) => call.method === "conversations.compact")).toBe(true);
	});

	test("/attach checks target write access and rebinds", async () => {
		const harness = await rig();
		const target = (await harness.host.conversations.create({ owner: "alice" })) as number;
		await harness.run(`/attach ${target}`);
		expect(harness.bindings.get(KEY)?.conversationId).toBe(target);
		expect(harness.bindings.get(KEY)?.previous).toEqual([harness.conversationId]);
	});

	test("/status includes the name, model, busy/queued state, and bound id", async () => {
		const harness = await rig();
		installViews(harness.host, view(true, 2));
		await harness.run("/status");
		const text = harness.sent.at(-1)?.text ?? "";
		expect(text).toContain("Loop DM");
		expect(text).toContain("faux/m");
		expect(text).toContain("busy, 2 queued");
		expect(text).toContain(String(harness.conversationId));
	});

	test("selfLink false refuses /link without redeeming a code", async () => {
		const harness = await rig();
		const code = harness.deps.linkCodes.issue("alice", "loop", 1_000);
		expect(await harness.run(`/link ${code}`)).toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("Self-linking is disabled on this channel.");
		expect(harness.identities.linkedUserOf("loop", "100000001")).toBeUndefined();
		expect(harness.deps.linkCodes.peek(code, "loop", 1_000)).toBe("alice");
	});

	test("/home moves the sender's home chat", async () => {
		const harness = await rig();
		await harness.run("/home");
		expect(harness.identities.homesOf("alice")).toEqual([{ channel: "loop", chat: CHAT }]);
	});

	test("/help appends extension commands but omits gateway-name collisions", async () => {
		const harness = await rig();
		harness.host.commands.list = async () => [
			{ name: "deploy", description: "Deploy the fixture", extension: "fixture" },
			{ name: "model", description: "Collision", extension: "fixture" },
			{ name: "fork", description: "Core command" },
		];
		await harness.run("/help");
		const text = harness.sent.at(-1)?.text ?? "";
		expect(text).toContain("/deploy");
		expect(text).not.toContain("Collision");
		expect(text).not.toContain("/fork");
	});
});

describe("expected command input errors", () => {
	test("/model with a malformed ref replies with a notice and resolves command", async () => {
		const harness = await rig();
		harness.host.conversations.configure = (async () => {
			const error = new Error("invalid_field");
			error.name = "ConversationOpError";
			Object.assign(error, { body: { error: "invalid_field", field: "model" } });
			throw error;
		}) as typeof harness.host.conversations.configure;
		await expect(harness.run("/model missing-slash")).resolves.toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("Could not run /model: invalid_field model.");
	});

	test("/attach of an unknown conversation replies with a notice and does not throw", async () => {
		const harness = await rig();
		const originalMeta = harness.host.conversations.meta.bind(harness.host.conversations);
		harness.host.conversations.meta = (async (id) => {
			if ((id as number) === 999999) throw new Error("conversation 999999 not found");
			return originalMeta(id);
		}) as typeof harness.host.conversations.meta;
		await expect(harness.run("/attach 999999")).resolves.toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("conversation 999999 not found.");
		expect(harness.bindings.get(KEY)?.conversationId).toBe(harness.conversationId);
	});

	test("/attach rejects an unsafe integer id without any host lookup", async () => {
		const harness = await rig();
		let metaCalls = 0;
		const originalMeta = harness.host.conversations.meta.bind(harness.host.conversations);
		harness.host.conversations.meta = (async (id) => {
			metaCalls++;
			if ((id as number) !== harness.conversationId) {
				throw new Error("unexpected target host lookup");
			}
			return originalMeta(id);
		}) as typeof harness.host.conversations.meta;
		await expect(harness.run("/attach 1111111111111111111111")).resolves.toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("Unknown conversation.");
		// Only the pre-command access check may read meta; the unsafe target
		// itself must never reach the host.
		expect(metaCalls).toBe(1);
		expect(harness.bindings.get(KEY)?.conversationId).toBe(harness.conversationId);
	});

	test("/attach classifies exponential bridge not-found formatting", async () => {
		const harness = await rig();
		const originalMeta = harness.host.conversations.meta.bind(harness.host.conversations);
		harness.host.conversations.meta = (async (id) => {
			if ((id as number) === 9007199254740991) {
				throw new Error("conversation 1.1111111111111111e+21 not found");
			}
			return originalMeta(id);
		}) as typeof harness.host.conversations.meta;
		await expect(harness.run("/attach 9007199254740991")).resolves.toBe("command");
		expect(harness.sent.at(-1)?.text).toBe("conversation 1.1111111111111111e+21 not found.");
	});

	test("unexpected host failures still propagate for platform redelivery", async () => {
		const harness = await rig();
		harness.host.conversations.configure = (async () => {
			throw new Error("synthetic storage failure");
		}) as typeof harness.host.conversations.configure;
		await expect(harness.run("/model faux/m")).rejects.toThrow("synthetic storage failure");
	});
});

describe("native command menu", () => {
	test("engine start installs the merged gateway/extension menu", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-command-menu-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir });
		await host.stores.settings.set({ channels: { loop: {} } });
		host.commands.list = async () => [
			{ name: "deploy", description: "Deploy the fixture", extension: "fixture" },
			{ name: "model", description: "Collision", extension: "fixture" },
		];
		const menus: (readonly { readonly name: string; readonly description: string }[])[] = [];
		const channel: ChannelContribution = {
			id: "loop",
			label: "Loop",
			capabilities: {
				chatTypes: ["dm"],
				maxMessageLength: 200,
				format: "markdown",
				commandMenu: true,
			},
			configured: () => ({ status: "ready" }),
			start: async () => {},
			send: async () => ({ messageIds: [] }),
			setCommands: async (commands) => {
				menus.push(commands);
			},
		};
		const engine = createEngine(host);
		await engine.start({
			channels: [{ extension: "fixture", channel }],
			signal: new AbortController().signal,
		});
		expect(menus).toHaveLength(1);
		expect(menus[0]?.map((command) => command.name)).toEqual([
			...GATEWAY_COMMANDS.map((command) => command.name),
			"deploy",
		]);
		await engine.stop();
	});
});
