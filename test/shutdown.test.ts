/**
 * Engine shutdown and user cleanup (Task 12, spec §8.13): intake closes
 * before the delivery drain; delivery is bounded before adapter stop; a
 * hanging adapter is abandoned; deleting a user removes links and homes.
 *
 * Tests own their literals: alice/bob, "100000001", example.invalid.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
	ChannelContext,
	ChannelContribution,
	OutboundMessage,
	RunSettledEvent,
} from "@sigrun/sigrun/extension";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import createGateway from "../src/index.js";
import { createEngine, type EngineInternals } from "../src/engine.js";
import type { GatewayEngine } from "@sigrun/sigrun/extension";

const CHAT = { chatId: "100000001", chatType: "dm" } as const;
const KEY = "loop:default:dm:100000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function silentLog(): import("../src/log.js").EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

interface FakeChannel extends ChannelContribution {
	readonly contexts: readonly ChannelContext[];
	readonly sent: readonly OutboundMessage[];
	readonly calls: readonly string[];
	hangStop: boolean;
}

function fakeChannel(): FakeChannel {
	const contexts: ChannelContext[] = [];
	const sent: OutboundMessage[] = [];
	const calls: string[] = [];
	const channel: FakeChannel = {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm"],
			maxMessageLength: 200,
			format: "markdown",
		},
		configured: () => ({ status: "ready" }),
		start: async (ctx) => {
			contexts.push(ctx);
		},
		send: async (message) => {
			calls.push(`send:${message.text}`);
			sent.push(message);
			return { messageIds: [`loop-${sent.length}`] };
		},
		stop: async () => {
			calls.push("stop");
			if (channel.hangStop) await new Promise<void>(() => {});
		},
		contexts,
		sent,
		calls,
		hangStop: false,
	};
	return channel;
}

interface Rig {
	readonly host: FakeHost;
	readonly channel: FakeChannel;
	readonly engine: GatewayEngine & EngineInternals;
	readonly ledger: import("../src/state/ledger.js").Ledger;
	readonly context: ChannelContext;
}

async function rig(log = silentLog()): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-shutdown-"));
	cleanups.push(async () => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice", admin: true }, { user: "bob" }],
	});
	await host.stores.settings.set({
		channels: { loop: { dm: "pairing", stream: true } },
	});
	const channel = fakeChannel();
	const { Ledger } = await import("../src/state/ledger.js");
	const ledger = new Ledger(join(host.stores.paths.state, "gateway", "ledger.json"));
	const engine = createEngine(host, { log, deliveryLedger: ledger });
	await engine.start({
		channels: [{ extension: "fixture", channel }],
		signal: new AbortController().signal,
	});
	const context = channel.contexts[0];
	if (context === undefined) throw new Error("adapter was not started");
	return { host, channel, engine, ledger, context };
}

function answered(conversationId: number, text: string): RunSettledEvent {
	const answer: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} satisfies Usage,
		stopReason: "stop",
		timestamp: 0,
	};
	return {
		conversationId: conversationId as ConversationId,
		inputs: [1 as SubmissionId],
		inputTexts: ["hello"],
		outcome: {
			status: "answered",
			answerEntryId: 2 as EntryId,
			answer,
		},
	};
}

/** Link the DM sender used by the delivery tests to a directory user. */
async function rigIdentity(
	engine: GatewayEngine & EngineInternals,
	user: string,
): Promise<void> {
	await engine.accessState().identities.link("loop", CHAT.chatId, user, "pairing", CHAT);
}

describe("engine shutdown (§8.13)", () => {
	test("stopIntake drops later receive/action without state writes; adapters stay connected", { timeout: 10_000 }, async () => {
		const { host, channel, engine, context } = await rig();
		await engine.stopIntake();
		const before = await readFile(join(engine.stateDir, "seen.json"), "utf8").catch(() => "");
		const callsBefore = host.calls.length;
		await expect(context.receive({
			messageId: "100000001",
			chat: CHAT,
			sender: { id: "100000001", name: "Alice" },
			text: "after intake closed",
		})).resolves.toEqual({ outcome: "dropped" });
		await context.action({
			chat: CHAT,
			sender: { id: "100000001", name: "Alice" },
			data: "unknown-token",
		});
		expect(host.calls.slice(callsBefore).some((call) => call.method === "conversations.submit")).toBe(false);
		const after = await readFile(join(engine.stateDir, "seen.json"), "utf8").catch(() => "");
		expect(after).toBe(before);
		expect(channel.calls).not.toContain("stop");
		expect(context.signal.aborted).toBe(false);
		await engine.stop();
	});

	test("stop drains a pending settled entry before adapter stop and releases its watch", { timeout: 10_000 }, async () => {
		const { host, channel, engine, context } = await rig();
		await rigIdentity(engine, "alice");
		const outcome = await context.receive({
			messageId: "shutdown-run",
			chat: CHAT,
			sender: { id: CHAT.chatId, name: "Alice" },
			text: "deliver this answer during shutdown",
		});
		expect(outcome).toEqual({ outcome: "admitted" });
		const submit = host.calls.find((call) => call.method === "conversations.submit");
		const conversationId = submit?.args[0] as ConversationId;
		expect(host.watchCount(conversationId)).toBe(1);
		await engine.settle(
			answered(conversationId, "delivered at shutdown"),
			{
				entry: async () => undefined,
				entries: async () => ({ items: [], nextCursor: undefined }),
				document: async <T extends JsonObject>(token: import("@earendil-works/pi-durable").ConversationDocToken<T>) => {
					const { SessionMetaDoc } = await import("../src/session-meta.js");
					if (token.definition.kind !== SessionMetaDoc.definition.kind || token.definition.scope !== SessionMetaDoc.definition.scope) throw new Error("unexpected document token");
					return (await host.conversations.meta(conversationId)) as unknown as T;
				},
			},
			host.context,
		);
		// Match the real order: the settled fan-out has enqueued its final,
		// then stop drains it before disconnecting the adapter.
		await engine.stop();
		expect(channel.calls.indexOf("send:delivered at shutdown")).toBeGreaterThanOrEqual(0);
		expect(channel.calls.indexOf("stop")).toBeGreaterThan(channel.calls.indexOf("send:delivered at shutdown"));
		expect(host.watchCount(conversationId)).toBe(0);
	});

	test("a hanging adapter.stop is abandoned at 5000 ms", { timeout: 10_000 }, async () => {
		const { channel, engine } = await rig();
		vi.useFakeTimers();
		channel.hangStop = true;
		let settled = false;
		const stopping = engine.stop().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(4999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await stopping;
		expect(settled).toBe(true);
		expect(channel.calls).toContain("stop");
	});

	test("stop preserves an entry whose send cannot complete before the drain deadline", { timeout: 10_000 }, async () => {
		const { host, channel, engine, ledger: engineLedger } = await rig();
		await rigIdentity(engine, "alice");
		vi.useFakeTimers();
		channel.send = async () => await new Promise(() => {});
		const conversationId = await host.conversations.create({ owner: "alice", source: "gateway" });
		const { BindingStore } = await import("../src/state/bindings.js");
		const bindings = new BindingStore(join(engine.stateDir, "bindings.json"));
		await bindings.bind(KEY, conversationId, CHAT);
		await engineLedger.enqueue({
			channel: "loop",
			bindingKey: KEY,
			chat: CHAT,
			kind: "final",
			message: { chat: CHAT, text: "left for next boot" },
		});
		const stopping = engine.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(5000);
		await stopping;
		// The bounded stop abandons the hung adapter call, not the already
		// queued attempting write. A no-delivery settle serializes behind it,
		// making the durable leftover observable without a timing sleep.
		await engine.settle(
			answered(999, "no bound chat"),
			{
				entry: async () => undefined,
				entries: async () => ({ items: [], nextCursor: undefined }),
				document: async <T extends JsonObject>(token: import("@earendil-works/pi-durable").ConversationDocToken<T>) => {
					const { SessionMetaDoc } = await import("../src/session-meta.js");
					if (token.definition.kind !== SessionMetaDoc.definition.kind || token.definition.scope !== SessionMetaDoc.definition.scope) throw new Error("unexpected document token");
					return (await host.conversations.meta(999 as ConversationId)) as unknown as T;
				},
			},
			host.context,
		);
		expect(engineLedger.list().map((entry) => entry.state)).toEqual(["attempting"]);
		const persisted = JSON.parse(await readFile(join(engine.stateDir, "ledger.json"), "utf8")) as {
			entries: { state: string }[];
		};
		expect(persisted.entries.map((entry) => entry.state)).toEqual(["attempting"]);
	});
});

describe("user deletion", () => {
	test("userDeleted removes homes only after core removed the links", async () => {
		const host = await createFakeHost({ users: [{ user: "alice" }, { user: "bob" }] });
		cleanups.push(host.close);
		const result = createGateway(host);
		const identities = result.gateway === undefined
			? undefined
			: (result.gateway as GatewayEngine & EngineInternals).accessState().identities;
		if (identities === undefined) throw new Error("gateway missing");
		await identities.link("loop", "100000001", "bob", "pairing", CHAT);
		await identities.link("loop", "200000002", "alice", "self", {
			chatId: "200000002",
			chatType: "dm",
		});
		expect(identities.homesOf("bob")).toHaveLength(1);
		if (result.userDeleted === undefined) throw new Error("userDeleted handler missing");
		// Core's deletion route removes account links before this event.
		await host.accounts.unlink("chat:loop", "100000001");
		await result.userDeleted(
			{ user: "bob", transferTo: "alice" },
			{
				entry: async () => undefined,
				entries: async () => ({ items: [], nextCursor: undefined }),
				document: async () => undefined,
			},
			host.context,
		);
		const { parseGatewayConfig } = await import("../src/config.js");
		const block = parseGatewayConfig({ channels: { loop: {} } }).channels.loop;
		if (block === undefined || "failed" in block) throw new Error("bad test config");
		expect(await identities.userFor(block, "loop", "100000001")).toBeUndefined();
		expect((await identities.userFor(block, "loop", "200000002"))?.user).toBe("alice");
		expect(identities.homesOf("bob")).toEqual([]);
		expect(identities.homesOf("alice")).toHaveLength(1);
	});
});
