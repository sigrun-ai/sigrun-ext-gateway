/**
 * Job delivery targets (spec §8.8): target grammar and authorization.
 * Tests own their literals: alice/bob, "100000001", "999".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ChatRef } from "@sigrun/sigrun/extension";
import { parseTarget, resolveTargets } from "../src/jobs.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";
import { IdentityStore } from "../src/state/identities.js";
import { createFakeHost } from "./fake-host.js";
import { onRunSettled, type SettledDeps } from "../src/outbound/settled.js";
import { Ledger } from "../src/state/ledger.js";
import type { RunSettledEvent } from "@sigrun/sigrun/extension";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/views";
import type { EngineLog } from "../src/log.js";

const HOME: ChatRef = { chatId: "100000001", chatType: "dm" };
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("parseTarget", () => {
	test.each([
		["loop", { channel: "loop" }],
		["chat-2", { channel: "chat-2" }],
		["loop:999", { channel: "loop", chatId: "999" }],
		["loop:chat:with:colons", { channel: "loop", chatId: "chat:with:colons" }],
	])("accepts %s", (target, expected) => {
		expect(parseTarget(target)).toEqual(expected);
	});

	test.each([
		"",
		"Loop",
		"2loop",
		"-loop",
		"loop_name",
		"loop:",
		":999",
		" loop",
		"loop ",
	])("rejects %s", (target) => {
		expect(parseTarget(target)).toBeUndefined();
	});
});

describe("resolveTargets", () => {
	async function rig(): Promise<{
		host: Awaited<ReturnType<typeof createFakeHost>>;
		bindings: BindingStore;
		identities: IdentityStore;
	}> {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-jobs-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({
			storesDir: dir,
			users: [{ user: "alice" }, { user: "bob" }],
		});
		const identities = new IdentityStore(host, join(dir, "identities.json"));
		await identities.link("loop", "100000001", "alice", "pairing", HOME);
		return {
			host,
			bindings: new BindingStore(join(dir, "bindings.json")),
			identities,
		};
	}

	test("a bare channel resolves to the owner's home DM", async () => {
		const { host, bindings, identities } = await rig();
		const result = await resolveTargets(
			{ host, bindings, identities },
			"alice",
			["loop"],
		);
		expect(result).toEqual({
			resolved: [{ channel: "loop", chat: HOME }],
			rejected: [],
		});
	});

	test("the explicit home chat id is allowed", async () => {
		const { host, bindings, identities } = await rig();
		const result = await resolveTargets(
			{ host, bindings, identities },
			"alice",
			["loop:100000001"],
		);
		expect(result.rejected).toEqual([]);
		expect(result.resolved).toEqual([{ channel: "loop", chat: HOME }]);
	});

	test("an explicit chat is allowed only through a writable binding", async () => {
		const { host, bindings, identities } = await rig();
		const owned = (await host.conversations.create({ owner: "alice" })) as number;
		const foreign = (await host.conversations.create({ owner: "bob" })) as number;
		await bindings.bind(bindingKey("loop", { chatId: "42", chatType: "group" }), owned, {
			chatId: "42",
			chatType: "group",
		});
		await bindings.bind(bindingKey("loop", { chatId: "43", chatType: "group" }), foreign, {
			chatId: "43",
			chatType: "group",
		});
		const result = await resolveTargets(
			{ host, bindings, identities },
			"alice",
			["loop:42", "loop:43", "loop:999"],
		);
		expect(result.resolved).toEqual([
			{ channel: "loop", chat: { chatId: "42", chatType: "group" } },
		]);
		expect(result.rejected.map((row) => row.target)).toEqual([
			"loop:43",
			"loop:999",
		]);
	});

	test("a dead binding cannot authorize an explicit chat", async () => {
		const { host, bindings, identities } = await rig();
		const owned = (await host.conversations.create({ owner: "alice" })) as number;
		const chat = { chatId: "42", chatType: "group" } as const;
		await bindings.bind(bindingKey("loop", chat), owned, chat);
		await bindings.markDead(bindingKey("loop", chat));
		const result = await resolveTargets(
			{ host, bindings, identities },
			"alice",
			["loop:42"],
		);
		expect(result).toEqual({
			resolved: [],
			rejected: [{ target: "loop:42", reason: "chat is gone" }],
		});
	});

	test("missing home chats and malformed targets are reported", async () => {
		const { host, bindings, identities } = await rig();
		const result = await resolveTargets(
			{ host, bindings, identities },
			"alice",
			["other", "BAD"],
		);
		expect(result.resolved).toEqual([]);
		expect(result.rejected.map((row) => row.target)).toEqual(["other", "BAD"]);
	});
});

describe("job delivery at run settle", () => {
	async function settledRig(deliver: readonly string[]): Promise<{
		id: ConversationId;
		ledger: Ledger;
		deps: SettledDeps;
		warnings: string[];
	}> {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-settle-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
		const id = await host.conversations.create({ owner: "alice", name: "Nightly report" });
		await host.conversations.patchMeta(id, { name: "Nightly report" });
		(host.metas as Map<ConversationId, SessionMeta>).set(id, {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "cron",
			owner: "alice",
			name: "Nightly report",
			jobId: "api:nightly",
			deliver: [...deliver],
		});
		const bindings = new BindingStore(join(dir, "bindings.json"));
		const identities = new IdentityStore(host, join(dir, "identities.json"));
		await identities.link("loop", "100000001", "alice", "pairing", HOME);
		const ledger = new Ledger(join(dir, "ledger.json"));
		const warnings: string[] = [];
		const log: EngineLog = {
			info: () => {},
			warn: (message) => { warnings.push(message); },
			error: () => {},
			debug: () => {},
			once: () => {},
		};
		const deps: SettledDeps = {
			host,
			bindings,
			identities,
			ledger,
			channelOf: () => ({
				id: "loop",
				label: "Loop",
				capabilities: { chatTypes: ["dm", "group"], maxMessageLength: 2000, format: "markdown" },
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: async () => ({ messageIds: ["loop-1"] }),
			}),
			configOf: async () => undefined,
			origins: new Map(),
			streams: { finalize: async () => false, abandon: () => {} },
			log,
		};
		return { id, ledger, deps, warnings };
	}

	function answered(id: ConversationId, text = "job answer"): RunSettledEvent {
		return {
			conversationId: id,
			inputs: [1 as SubmissionId],
			inputTexts: ["say ok"],
			outcome: {
				status: "answered",
				answerEntryId: 9 as EntryId,
				answer: assistant(text),
			},
		};
	}

	test("an explicit bound chat resolves and receives the job answer", async () => {
		const { id, ledger, deps } = await settledRig(["loop:42"]);
		const chat = { chatId: "42", chatType: "group" } as const;
		const owned = await deps.host.conversations.create({ owner: "alice" });
		await deps.bindings.bind(bindingKey("loop", chat), owned as number, chat);
		await onRunSettled(answered(id), deps);
		const entry = ledger.nextPending("loop");
		expect(entry?.chat).toEqual(chat);
		expect(entry?.message.text).toBe("Job Nightly report\njob answer");
	});

	test("a rejected target warns and enqueues no job entry", async () => {
		const { id, ledger, deps, warnings } = await settledRig(["loop:999"]);
		await onRunSettled(answered(id), deps);
		expect(ledger.nextPending("loop")).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("loop:999");
	});

	test("a target whose channel is absent is skipped and warned", async () => {
		const { id, ledger, deps, warnings } = await settledRig(["loop"]);
		const withoutChannel: SettledDeps = { ...deps, channelOf: () => undefined };
		await onRunSettled(answered(id), withoutChannel);
		expect(ledger.nextPending("loop")).toBeUndefined();
		expect(warnings).toEqual(['job delivery skipped: no channel "loop"']);
	});

	test("a delivered job answer is tagged once; later runs in that conversation skip", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-settle-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
		const id = await host.conversations.create({ owner: "alice", name: "Nightly report" });
		await host.conversations.patchMeta(id, { name: "Nightly report" });
		(host.metas as Map<ConversationId, SessionMeta>).set(id, {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "cron",
			owner: "alice",
			name: "Nightly report",
			jobId: "api:nightly",
			deliver: ["loop"],
		});
		const bindings = new BindingStore(join(dir, "bindings.json"));
		const identities = new IdentityStore(host, join(dir, "identities.json"));
		await identities.link("loop", "100000001", "alice", "pairing", HOME);
		const ledger = new Ledger(join(dir, "ledger.json"));
		const log: EngineLog = {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			once: () => {},
		};
		const deps: SettledDeps = {
			host,
			bindings,
			identities,
			ledger,
			channelOf: () => ({
				id: "loop",
				label: "Loop",
				capabilities: { chatTypes: ["dm"], maxMessageLength: 2000, format: "markdown" },
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: async () => ({ messageIds: ["loop-1"] }),
			}),
			configOf: async () => undefined,
			origins: new Map(),
			streams: { finalize: async () => false, abandon: () => {} },
			log,
		};
		const event = (entry: number): RunSettledEvent => ({
			conversationId: id,
			inputs: [1 as SubmissionId],
			inputTexts: ["say ok"],
			outcome: {
				status: "answered",
				answerEntryId: entry as EntryId,
				answer: assistant(entry === 9 ? "job answer" : "follow-up answer"),
			},
		});
		await onRunSettled(event(9), deps);
		const first = ledger.nextPending("loop");
		expect(first?.message.text).toBe("Job Nightly report\njob answer");
		expect(first?.tag).toBe(`job:${id as number}:loop:100000001:0`);
		await ledger.mark(first!.id, "delivered");
		await onRunSettled(event(10), deps);
		expect(ledger.nextPending("loop")).toBeUndefined();
	});
});

function assistant(text: string): AssistantMessage {
	return {
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
}
