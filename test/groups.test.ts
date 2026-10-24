/**
 * Group admission and sharing (Task 8, spec §8.2/§8.3): mention gating,
 * member modes, the synchronous admission result, group creation, and
 * people-sharing updates over FakeHost.
 *
 * Tests own their literals: alice/bob/mallory and "-100000000002".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
	ChannelContribution,
	ChatRef,
	InboundEvent,
	OutboundMessage,
	SubmissionInputPart,
} from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createFakeHost } from "./fake-host.js";
import {
	admitGroupEvent,
	ensureGroupShare,
} from "../src/inbound/groups.js";
import {
	parseGatewayConfig,
	type ChannelConfig,
	type GroupConfig,
} from "../src/config.js";
import { IdentityStore } from "../src/state/identities.js";
import { createPipeline, type AccessState } from "../src/inbound/pipeline.js";
import { ButtonTokens } from "../src/inbound/tokens.js";
import { LinkCodes } from "../src/access/link-codes.js";
import { PairingStore } from "../src/access/pairing.js";
import { LoopGuard } from "../src/access/loop-guard.js";
import type { EngineLog } from "../src/log.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const CHAT: ChatRef = { chatId: "-100000000002", chatType: "group" };

function event(over: Partial<InboundEvent> = {}): InboundEvent {
	return {
		messageId: "m1",
		chat: CHAT,
		sender: { id: "100000001", name: "Alice" },
		text: "hello group",
		mentioned: true,
		...over,
	};
}

function config(groups: readonly Record<string, unknown>[]): ChannelConfig {
	const parsed = parseGatewayConfig({ channels: { loop: { groups } } }).channels.loop;
	if (parsed === undefined || "failed" in parsed) {
		throw new Error("test setup: loop channel must parse");
	}
	return parsed;
}

async function identities(): Promise<IdentityStore> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-groups-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const store = new IdentityStore(join(dir, "identities.json"));
	await store.link("loop", "100000001", "alice", "pairing", {
		chatId: "100000001",
		chatType: "dm",
	});
	await store.link("loop", "200000002", "bob", "pairing", {
		chatId: "200000002",
		chatType: "dm",
	});
	return store;
}

describe("admitGroupEvent", () => {
	test("an unlisted group is refused", async () => {
		expect(admitGroupEvent(config([]), "loop", event(), await identities())).toEqual({
			admit: false,
			reason: "unlisted",
		});
	});

	test("a malformed listed group is refused as failed", async () => {
		const malformed = parseGatewayConfig({
			channels: {
				loop: {
					groups: [{ chat: CHAT.chatId, owner: "alice", mention: "sometimes" }],
				},
			},
		}).channels.loop;
		if (malformed === undefined || "failed" in malformed) {
			throw new Error("test setup: channel parse failed");
		}
		expect(admitGroupEvent(malformed, "loop", event(), await identities())).toEqual({
			admit: false,
			reason: "failed",
		});
	});

	test("mention required drops an unmentioned message", async () => {
		const cfg = config([{ chat: CHAT.chatId, owner: "alice", mention: "required" }]);
		expect(
			admitGroupEvent(cfg, "loop", event({ mentioned: false }), await identities()),
		).toEqual({ admit: false, reason: "mention" });
	});

	test("mention always admits an unmentioned linked member", async () => {
		const cfg = config([{ chat: CHAT.chatId, owner: "alice", mention: "always" }]);
		const result = admitGroupEvent(
			cfg,
			"loop",
			event({ mentioned: false }),
			await identities(),
		);
		expect(result).toMatchObject({
			admit: true,
			user: "alice",
			linked: true,
			senderLabel: "Alice",
		});
	});

	test("linked mode drops an unlinked sender", async () => {
		const cfg = config([{ chat: CHAT.chatId, owner: "alice", members: "linked" }]);
		expect(
			admitGroupEvent(
				cfg,
				"loop",
				event({ sender: { id: "300000003", name: "Mallory" } }),
				await identities(),
			),
		).toEqual({ admit: false, reason: "unlinked" });
	});

	test("anyone mode admits an unlinked sender under the group owner", async () => {
		const cfg = config([
			{
				chat: CHAT.chatId,
				owner: "alice",
				members: "anyone",
				tools: ["read"],
			},
		]);
		expect(
			admitGroupEvent(
				cfg,
				"loop",
				event({ sender: { id: "300000003", name: "Mallory" } }),
				await identities(),
			),
		).toMatchObject({
			admit: true,
			user: "alice",
			linked: false,
			senderLabel: "Mallory (not linked)",
		});
	});
});

describe("ensureGroupShare", () => {
	test("merges a new member with an existing people share and is idempotent", async () => {
		const host = await createFakeHost({ users: [{ user: "alice" }] });
		cleanups.push(host.close);
		const id = await host.conversations.create({ owner: "alice" });
		await host.conversations.patchMeta(id, {
			sharing: { scope: "people", users: ["bob"], level: "write" },
		});
		await ensureGroupShare(host, id, "mallory");
		expect((await host.conversations.meta(id)).sharing).toEqual({
			scope: "people",
			users: ["bob", "mallory"],
			level: "write",
		});
		const patches = host.calls.filter((call) => call.method === "conversations.patchMeta");
		await ensureGroupShare(host, id, "mallory");
		expect(host.calls.filter((call) => call.method === "conversations.patchMeta")).toHaveLength(
			patches.length,
		);
	});

	test("a linked speaker gains write sharing when the conversation had none", async () => {
		const host = await createFakeHost({ users: [{ user: "alice" }] });
		cleanups.push(host.close);
		const id = await host.conversations.create({ owner: "alice" });
		await ensureGroupShare(host, id, "bob");
		expect((await host.conversations.meta(id)).sharing).toEqual({
			scope: "people",
			users: ["bob"],
			level: "write",
		});
	});

	test("the owner is never added to people sharing", async () => {
		const host = await createFakeHost({ users: [{ user: "alice" }] });
		cleanups.push(host.close);
		const id = await host.conversations.create({ owner: "alice" });
		await ensureGroupShare(host, id, "alice");
		expect((await host.conversations.meta(id)).sharing).toBeUndefined();
	});
});

function silentLog(): EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

function fakeChannel(): ChannelContribution & { sent: { text: string }[] } {
	const adapter = {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm", "group", "thread"] as const,
			maxMessageLength: 200,
			format: "markdown" as const,
		},
		configured: () => ({ status: "ready" as const }),
		start: async () => {},
		send: async (message: OutboundMessage) => {
			adapter.sent.push({ text: message.text });
			return { messageIds: [`loop-${adapter.sent.length}`] };
		},
		sent: [] as { text: string }[],
	};
	return adapter;
}

interface PipelineRig {
	host: Awaited<ReturnType<typeof createFakeHost>>;
	identities: IdentityStore;
	receive(event: InboundEvent): Promise<{ outcome: string }>;
}

async function pipelineRig(group: Record<string, unknown>): Promise<PipelineRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-groups-pipeline-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice" }, { user: "bob" }],
		directory: [
			{ user: "alice", name: "Alice Directory", admin: true, createdAt: 0, source: "cli" },
			{ user: "bob", admin: false, createdAt: 0, source: "cli" },
		],
	});
	const ids = await identities();
	const access: AccessState = {
		identities: ids,
		pairing: new PairingStore(join(dir, "pairing.json")),
		linkCodes: new LinkCodes(),
		tokens: new ButtonTokens(),
		loopGuard: new LoopGuard(),
	};
	const cfg = config([group]);
	const receive = createPipeline({
		host,
		channel: fakeChannel(),
		stateDir: dir,
		log: silentLog(),
		origins: new Map(),
		access,
	});
	return {
		host,
		identities: ids,
		receive: (inbound) => receive("loop", inbound, cfg),
	};
}

function submittedText(host: PipelineRig["host"]): string {
	const call = host.calls.find((entry) => entry.method === "conversations.submit");
	const parts = call?.args[1] as readonly SubmissionInputPart[] | undefined;
	const part = parts?.[0];
	return part?.type === "text" ? part.text : "";
}

describe("group pipeline", () => {
	test("linked admission creates a group conversation, shares, and uses the directory label", async () => {
		const rig = await pipelineRig({ chat: CHAT.chatId, owner: "alice", members: "linked" });
		expect(await rig.receive(event())).toEqual({ outcome: "admitted" });
		expect(rig.host.calls.find((call) => call.method === "conversations.create")?.args[0]).toEqual({
			owner: "alice",
			source: "gateway",
			name: "Loop group",
		});
		expect(submittedText(rig.host)).toBe("[Alice Directory] hello group");
		// The owner already has write access; sharing starts when another
		// linked member speaks.
		expect((await rig.host.conversations.meta(1 as ConversationId)).sharing).toBeUndefined();
		expect(await rig.receive(event({
			messageId: "m2",
			sender: { id: "200000002", name: "Bob" },
		}))).toEqual({ outcome: "admitted" });
		expect((await rig.host.conversations.meta(1 as ConversationId)).sharing).toEqual({
			scope: "people",
			users: ["bob"],
			level: "write",
		});
	});

	test("anyone creation pins exactly the configured agent selection", async () => {
		const rig = await pipelineRig({
			chat: CHAT.chatId,
			owner: "alice",
			members: "anyone",
			tools: ["read", "web_search"],
			extensions: ["memory"],
		});
		await rig.receive(event({ sender: { id: "300000003", name: "Mallory" } }));
		expect(rig.host.calls.find((call) => call.method === "conversations.create")?.args[0]).toEqual({
			owner: "alice",
			source: "gateway",
			name: "Loop group",
			agent: {
				tools: ["read", "web_search"],
				// The config parser keeps the gateway prompt extension in anyone groups.
				extensions: ["memory", "gateway"],
			},
		});
		expect(submittedText(rig.host)).toBe("[Mallory (not linked)] hello group");
	});
});
