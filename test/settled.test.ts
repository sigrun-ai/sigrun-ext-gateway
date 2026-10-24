/**
 * onRunSettled (spec §8.6's "which runs deliver" + the M7 access
 * re-check): every key bound to the settled conversation gets a final
 * (or the empty-answer notice), revoked access unbinds and enqueues
 * nothing, and unanswered runs notify the ORIGIN chat only.
 *
 * Tests own their literals: alice, "100000001", a fake host.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
	ChannelContribution,
	ChatRef,
	OutboundMessage,
	RunSettledEvent,
} from "@sigrun/sigrun/extension";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { onRunSettled, type SettledDeps } from "../src/outbound/settled.js";
import { bindingKey, BindingStore } from "../src/state/bindings.js";
import { Ledger } from "../src/state/ledger.js";
import { IdentityStore } from "../src/state/identities.js";
import { createPipeline, type SubmissionOrigin } from "../src/inbound/pipeline.js";
import { parseGatewayConfig, type ChannelConfig } from "../src/config.js";
import type {
	ConversationId,
	EntryId,
	SubmissionId,
} from "@earendil-works/pi-durable";

const CHAT: ChatRef = { chatId: "100000001", chatType: "dm" };
const KEY = bindingKey("loop", CHAT);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
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

/** A faux assistant answer (text-only). */
function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
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

/** The settled-event factory (an answered run). */
function answeredEvent(
	conversationId: number,
	answerText: string,
): RunSettledEvent {
	return {
		conversationId: conversationId as ConversationId,
		inputs: [1 as SubmissionId],
		inputTexts: ["hello"],
		outcome: {
			status: "answered",
			answerEntryId: 9 as EntryId,
			answer: answer(answerText),
		},
	};
}

/** The settled-event factory (an unanswered run). */
function unansweredEvent(
	conversationId: number,
	reason: string,
): RunSettledEvent {
	return {
		conversationId: conversationId as ConversationId,
		inputs: [1 as SubmissionId],
		inputTexts: ["hello"],
		outcome: { status: "unanswered", reason },
	};
}

/** The fake channel the deps' render/format ride. */
function fakeChannel(): ChannelContribution {
	return {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm"],
			maxMessageLength: 200,
			format: "markdown",
		},
		configured: () => ({ status: "ready" }),
		start: async () => {},
		send: async () => ({ messageIds: ["loop-1"] }),
	};
}

/** The settled rig: a fake host, bindings, ledger, and one deps bundle. */
interface Rig {
	readonly host: FakeHost;
	readonly bindings: BindingStore;
	readonly identities: IdentityStore;
	readonly ledger: Ledger;
	readonly deps: SettledDeps;
	readonly channelOf: (id: string) => ChannelContribution | undefined;
}

async function rig(): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-settled-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
	const bindings = new BindingStore(join(dir, "bindings.json"), {
		now: () => 1000,
	});
	const identities = new IdentityStore(join(dir, "identities.json"));
	// The DM link the access re-check reads (chat 100000001 → alice).
	await identities.link("loop", "100000001", "alice", "pairing", CHAT);
	const ledger = new Ledger(join(dir, "ledger.json"), { now: () => 1000 });
	const channel = fakeChannel();
	const channelOf = (id: string): ChannelContribution | undefined =>
		id === "loop" ? channel : undefined;
	const configOf = async (id: string): Promise<ChannelConfig | undefined> => {
		if (id !== "loop") return undefined;
		const parsed = parseGatewayConfig({ channels: { loop: { dm: "allowlist" } } });
		const block = parsed.channels.loop;
		return block === undefined || "failed" in block ? undefined : block;
	};
	const deps: SettledDeps = {
		host,
		bindings,
		identities,
		ledger,
		channelOf,
		configOf,
		origins: new Map<SubmissionId, SubmissionOrigin>(),
		streams: { finalize: async () => false },
		log: silentLog(),
	};
	return { host, bindings, identities, ledger, deps, channelOf };
}

describe("onRunSettled: answered runs", () => {
	test("an answered run enqueues one final per bound key", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		await onRunSettled(answeredEvent(7, "the answer"), harness.deps);
		const entry = harness.ledger.nextPending("loop");
		expect(entry?.kind).toBe("final");
		expect(entry?.message.text).toBe("the answer");
		expect(entry?.bindingKey).toBe(KEY);
		expect(entry?.chat).toEqual(CHAT);
	});

	test("the entry's tag dedupes a replayed settle", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		await onRunSettled(answeredEvent(7, "the answer"), harness.deps);
		await onRunSettled(answeredEvent(7, "the answer"), harness.deps);
		const first = harness.ledger.nextPending("loop");
		await harness.ledger.mark(first!.id, "delivered");
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});

	test("an answer over the limit chunks into several finals", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		const text = `${"a".repeat(120)}\n\n${"b".repeat(120)}`;
		await onRunSettled(answeredEvent(7, text), harness.deps);
		const first = harness.ledger.nextPending("loop");
		expect(first?.message.text).toBe("a".repeat(120));
		await harness.ledger.mark(first!.id, "delivered");
		const second = harness.ledger.nextPending("loop");
		expect(second?.message.text).toBe("b".repeat(120));
	});

	test("a dead binding is skipped", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		await harness.bindings.markDead(KEY);
		await onRunSettled(answeredEvent(7, "the answer"), harness.deps);
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});

	test("an unbound conversation enqueues nothing", async () => {
		const harness = await rig();
		await onRunSettled(answeredEvent(99, "the answer"), harness.deps);
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});
});

describe("onRunSettled: empty answers (Review Focus 4)", () => {
	test("an answer with no text blocks enqueues the pinned notice", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		const event: RunSettledEvent = {
			conversationId: 7 as ConversationId,
			inputs: [1 as SubmissionId],
			inputTexts: ["hello"],
			outcome: {
				status: "answered",
				answerEntryId: 9 as EntryId,
				answer: { ...answer("ignored"), content: [] },
			},
		};
		await onRunSettled(event, harness.deps);
		const entry = harness.ledger.nextPending("loop");
		expect(entry?.message.text).toBe("(no text reply)");
	});

	test("thinking-only answers also read as empty", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		const event: RunSettledEvent = {
			conversationId: 7 as ConversationId,
			inputs: [1 as SubmissionId],
			inputTexts: ["hello"],
			outcome: {
				status: "answered",
				answerEntryId: 9 as EntryId,
				answer: {
					...answer("ignored"),
					content: [{ type: "thinking", thinking: "hmm" }],
				},
			},
		};
		await onRunSettled(event, harness.deps);
		const entry = harness.ledger.nextPending("loop");
		expect(entry?.message.text).toBe("(no text reply)");
	});
});

describe("onRunSettled: access re-check (M7)", () => {
	test("a revoked share unbinds the chat and enqueues nothing", async () => {
		const harness = await rig();
		// Conversation owned by bob, sharing private: alice (the linked
		// user for KEY) resolves to none → unbind + skip.
		const conversationId = (await harness.host.conversations.create({
			owner: "bob",
		})) as number;
		await harness.host.conversations.patchMeta(
			conversationId as import("@earendil-works/pi-durable").ConversationId,
			{
				sharing: { scope: "private" },
			},
		);
		await harness.bindings.bind(KEY, conversationId, CHAT);
		await onRunSettled(
			answeredEvent(conversationId, "the answer"),
			harness.deps,
		);
		expect(harness.bindings.get(KEY)).toBeUndefined();
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});

	test("an unavailable channel config skips WITHOUT unbinding (review fix 7)", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		const warnings: string[] = [];
		const deps: SettledDeps = {
			...harness.deps,
			// The channel block is {failed} — a config typo, not a revoked share.
			configOf: async () => undefined,
			log: {
				...silentLog(),
				warn: (msg: string) => warnings.push(msg),
			},
		};
		await onRunSettled(answeredEvent(7, "the answer"), deps);
		// The binding is RETAINED (a config typo never deletes chats).
		expect(harness.bindings.get(KEY)).toBeDefined();
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
		expect(warnings.some((line) => line.includes("binding kept"))).toBe(true);
	});

	test("an owner's own conversation still delivers", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		// Conversation 7 owned by alice (the linked user for KEY).
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-settled-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
		const conversationId = await host.conversations.create({ owner: "alice" });
		const bindings = new BindingStore(join(dir, "bindings.json"), {
			now: () => 1000,
		});
		await bindings.bind(KEY, conversationId as number, CHAT);
		const ledger = new Ledger(join(dir, "ledger.json"), { now: () => 1000 });
		const channel = fakeChannel();
		const identities = new IdentityStore(join(dir, "identities.json"));
		// The DM link the access re-check reads (chat 100000001 → alice).
		await identities.link("loop", "100000001", "alice", "pairing", CHAT);
		const deps: SettledDeps = {
			host,
			bindings,
			identities,
			ledger,
			channelOf: (id: string) => (id === "loop" ? channel : undefined),
			// The allowlist maps the DM sender to alice (the admission's own
			// resolution path — the same one the fan-out re-runs).
			configOf: async () =>
				parseGatewayConfig({
					channels: {
						loop: {
								dm: "allowlist",
								allow: [{ sender: "100000001", user: "alice" }],
							},
						},
				}).channels.loop as ChannelConfig,
			origins: new Map(),
			streams: { finalize: async () => false },
			log: silentLog(),
		};
		await onRunSettled(answeredEvent(conversationId as number, "the answer"), deps);
		expect(ledger.nextPending("loop")?.message.text).toBe("the answer");
	});
});

describe("onRunSettled: unanswered runs", () => {
	test("an unanswered run notifies the ORIGIN chat only", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		harness.deps.origins.set(1 as SubmissionId, {
			bindingKey: KEY,
			channel: "loop",
		});
		await onRunSettled(unansweredEvent(7, "model_error"), harness.deps);
		const entry = harness.ledger.nextPending("loop");
		expect(entry?.kind).toBe("notice");
		expect(entry?.message.text).toContain("model_error");
		// Exactly ONE entry: no final for the bound chat beyond the notice.
		await harness.ledger.mark(entry!.id, "delivered");
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});

	test("an abort reason reads exactly Stopped.", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		harness.deps.origins.set(1 as SubmissionId, {
			bindingKey: KEY,
			channel: "loop",
		});
		await onRunSettled(unansweredEvent(7, "aborted"), harness.deps);
		const entry = harness.ledger.nextPending("loop");
		expect(entry?.message.text).toBe("Stopped.");
	});

	test("a replayed unanswered settle dedupes through the notice tag", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		harness.deps.origins.set(1 as SubmissionId, {
			bindingKey: KEY,
			channel: "loop",
		});
		await onRunSettled(unansweredEvent(7, "model_error"), harness.deps);
		const first = harness.ledger.nextPending("loop");
		expect(first?.message.text).toContain("model_error");
		await harness.ledger.mark(first!.id, "delivered");
		// The replay (the platform redelivered the settle) enqueues nothing.
		await onRunSettled(unansweredEvent(7, "model_error"), harness.deps);
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});

	test("no origin (a webui-started run that failed to start) enqueues nothing", async () => {
		const harness = await rig();
		await onRunSettled(unansweredEvent(7, "model_error"), harness.deps);
		expect(harness.ledger.nextPending("loop")).toBeUndefined();
	});
});

describe("onRunSettled: the streaming hand-off stub", () => {
	test("streams.finalize is consulted once per conversation; false enqueues finals", async () => {
		const harness = await rig();
		await harness.bindings.bind(KEY, 7, CHAT);
		let finalizeCalls = 0;
		const deps: SettledDeps = {
			...harness.deps,
			streams: {
				finalize: async (conversationId: number) => {
					finalizeCalls++;
					expect(conversationId).toBe(7);
					return false;
				},
			},
		};
		await onRunSettled(answeredEvent(7, "the answer"), deps);
		expect(finalizeCalls).toBe(1);
		expect(harness.ledger.nextPending("loop")?.message.text).toBe("the answer");
	});

	test("finalize owning the stream skips only the ORIGIN chat; other bound chats still enqueue (review fix 5)", async () => {
		const harness = await rig();
		const otherChat: ChatRef = { chatId: "200000002", chatType: "dm" };
		const otherKey = bindingKey("loop", otherChat);
		await harness.bindings.bind(KEY, 7, CHAT);
		await harness.bindings.bind(otherKey, 7, otherChat);
		// The other chat's DM resolves to bob (a second directory user).
		await harness.identities.link("loop", "200000002", "bob", "pairing", otherChat);
		const deps: SettledDeps = {
			...harness.deps,
			configOf: async () => {
				const parsed = parseGatewayConfig({
					channels: {
						loop: {
							dm: "allowlist",
							allow: [
								{ sender: "100000001", user: "alice" },
								{ sender: "200000002", user: "bob" },
							],
						},
					},
				});
				return parsed.channels.loop as ChannelConfig;
			},
			streams: { finalize: async () => true },
			// The run came from THIS chat (the origin record).
			origins: new Map<SubmissionId, SubmissionOrigin>([
				[1 as SubmissionId, { bindingKey: KEY, channel: "loop" }],
			]),
		};
		await onRunSettled(answeredEvent(7, "the answer"), deps);
		// The origin chat's final is owned by the stream: NOTHING for it.
		const entries: string[] = [];
		for (;;) {
			const entry = harness.ledger.nextPending("loop");
			if (entry === undefined) break;
			entries.push(entry.bindingKey ?? "");
			await harness.ledger.mark(entry.id, "delivered");
		}
		// The OTHER chat still got its final.
		expect(entries).toEqual([otherKey]);
	});
});
