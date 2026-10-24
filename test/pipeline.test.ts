/**
 * createPipeline (Task 3, spec §8.4 steps 2, 3, 5, 6, 10 + the M12
 * submit-error outcomes) over FakeHost: allowlisted DM admission,
 * binding reuse, requestId/whenBusy wiring, drops (self/bot/unknown),
 * the album merge, and the three submit-error classes.
 *
 * FakeHost's `submit` is extended here with a failure mode so the
 * UnservedModelError / ConversationOpError / unexpected-throw cases run
 * against the real pipeline error handling. The submit-error classes
 * match by `name` (the engine repo cannot import sigrun's runtime
 * classes — only types ship), exactly like the runtime check does.
 *
 * Tests own their literals: alice/bob, "100000001".
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
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { createPipeline } from "../src/inbound/pipeline.js";
import { parseGatewayConfig } from "../src/config.js";
import { ALBUM_WINDOW_MS } from "../src/inbound/albums.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createEngine } from "../src/engine.js";
import type { ChannelContext } from "@sigrun/sigrun/extension";

/** Await `ms` (the album window's close rides a real timer). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The outcomes a receive resolves with. */
type Outcome = { outcome: "admitted" | "dropped" | "command" };

/** One recorded submit (the fake host's record carries inputs+opts). */
interface RecordedSubmit {
	conversationId: number;
	parts: readonly SubmissionInputPart[];
	opts?: { user?: string; requestId?: string; whenBusy?: string };
}

/** Where the pipeline's notice/error replies went (the adapter's send). */
interface SentMessage {
	chat: ChatRef;
	text: string;
}

/** The fake channel adapter the pipeline sends notices through. */
function fakeChannel(): ChannelContribution & { sent: SentMessage[] } {
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
			adapter.sent.push({ chat: message.chat, text: message.text });
			return { messageIds: [`loop-${adapter.sent.length}`] };
		},
		sent: [] as SentMessage[],
	};
	return adapter;
}

/** The default event factory (an allowlisted DM from sender 100000001). */
function dmEvent(over: Partial<InboundEvent> & { messageId: string }): InboundEvent {
	return {
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: "hello gateway",
		...over,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The pipeline harness: a fake host, its submits, and one pipeline. */
interface Rig {
	host: FakeHost;
	channel: ReturnType<typeof fakeChannel>;
	receive(event: InboundEvent): Promise<Outcome>;
	/** Submits recorded through the host's call log. */
	submits(): RecordedSubmit[];
}

/** Boot the rig with `channels.loop` settings (allowlist DMs by default). */
async function rig(
	gatewaySettings: Record<string, unknown> = {
		channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
	},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-pipeline-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice", admin: true }] });
	await host.stores.settings.set(gatewaySettings);
	const channel = fakeChannel();
	const raw = createPipeline({
		host,
		channel,
		stateDir: dir,
		log: silentLog(),
		origins: new Map(),
	});
	// The live channel block, parsed once from the test settings (the
	// engine reads it per event; the rig pins one shape).
	const parsed = parseGatewayConfig(gatewaySettings).channels.loop;
	if (parsed === undefined || "failed" in parsed) {
		throw new Error("test setup: loop channel must parse");
	}
	const config = parsed;
	const receive = (event: InboundEvent): Promise<Outcome> =>
		raw("loop", event, config);
	const submits = (): RecordedSubmit[] =>
		host.calls
			.filter((call) => call.method === "conversations.submit")
			.map((call) => ({
				conversationId: call.args[0] as number,
				parts: call.args[1] as readonly SubmissionInputPart[],
				opts: call.args[2] as RecordedSubmit["opts"],
			}));
	return { host, channel, receive, submits };
}

/** A log sink that stays quiet (pipeline logging is not under test here). */
function silentLog(): import("../src/log.js").EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

/** A named error class stand-in: the runtime check matches by `name`. */
function namedError(name: string, message: string, extra?: Record<string, unknown>): Error {
	const error = new Error(message);
	error.name = name;
	Object.assign(error, extra);
	return error;
}

/** Make the fake host's NEXT submit reject with `error`. */
function failNextSubmit(host: FakeHost, error: Error): void {
	// The fake host records every call; the failure is injected by
	// monkey-patching its submit once. The pipeline's error handling is
	// what runs against the rejection.
	const original = host.conversations.submit.bind(host.conversations);
	let armed = true;
	host.conversations.submit = (async (id, parts, opts) => {
		if (armed) {
			armed = false;
			throw error;
		}
		return original(id, parts, opts);
	}) as typeof host.conversations.submit;
}

describe("pipeline: allowlisted DM admission", () => {
	test("an allowlisted DM creates one conversation (owner alice, source gateway, name Loop DM)", async () => {
		const { host, receive, submits } = await rig();
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "admitted" });
		const created = host.calls.find((call) => call.method === "conversations.create");
		expect(created?.args[0]).toEqual({
			owner: "alice",
			source: "gateway",
			name: "Loop DM",
		});
		expect(submits()).toHaveLength(1);
	});

	test("a second message in the same chat reuses the conversation (no create)", async () => {
		const { host, receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1" }));
		await receive(dmEvent({ messageId: "m2", text: "second" }));
		const creates = host.calls.filter((call) => call.method === "conversations.create");
		expect(creates).toHaveLength(1);
		expect(submits()).toHaveLength(2);
		expect(submits()[1]?.conversationId).toBe(submits()[0]?.conversationId);
	});

	test("requestId is the binding key plus the message id", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m9" }));
		expect(submits()[0]?.opts?.requestId).toBe("loop:default:dm:100000001:m9");
	});

	test("whenBusy comes from the channel config (steer here)", async () => {
		const { receive, submits } = await rig({
			channels: {
				loop: {
					dm: "allowlist",
					allow: [{ sender: "100000001", user: "alice" }],
					busy: "steer",
				},
			},
		});
		await receive(dmEvent({ messageId: "m1" }));
		expect(submits()[0]?.opts?.whenBusy).toBe("steer");
	});

	test("submit opts carry the mapped user", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1" }));
		expect(submits()[0]?.opts?.user).toBe("alice");
	});

	test("the submission text is the DM envelope (as-is)", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1", text: "plain dm text" }));
		expect(submits()[0]?.parts).toEqual([
			{ type: "text", text: "plain dm text" },
		]);
	});

	test("admission records the submission in `origins`", async () => {
		const origins = new Map();
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-pipeline-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice", admin: true }] });
		await host.stores.settings.set({
			channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
		});
		const channel = fakeChannel();
		const raw = createPipeline({
			host,
			channel,
			stateDir: dir,
			log: silentLog(),
			origins,
		});
		const parsed = parseGatewayConfig({
			channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
		}).channels.loop;
		if (parsed === undefined || "failed" in parsed) {
			throw new Error("test setup: loop channel must parse");
		}
		await raw("loop", dmEvent({ messageId: "m1" }), parsed);
		expect(origins.size).toBe(1);
		const [key, value] = [...origins.entries()][0]!;
		expect(key).toBe(1);
		expect(value).toEqual({
			bindingKey: "loop:default:dm:100000001",
			channel: "loop",
			chat: { chatId: "100000001", chatType: "dm" },
		});
	});

	test("a bound ARCHIVED conversation is unarchived before submit", async () => {
		const { host, receive } = await rig();
		await receive(dmEvent({ messageId: "m1" }));
		const conversationId = host.calls.find(
			(call) => call.method === "conversations.submit",
		)?.args[0] as ConversationId;
		await host.conversations.patchMeta(conversationId, { archived: true });
		const patchesBefore = host.calls.filter((c) => c.method === "conversations.patchMeta");
		await receive(dmEvent({ messageId: "m2" }));
		const patchesAfter = host.calls.filter((c) => c.method === "conversations.patchMeta");
		expect(patchesAfter.length).toBe(patchesBefore.length + 1);
		expect(patchesAfter.at(-1)?.args[1]).toEqual({ archived: false });
	});
});

describe("pipeline: drops (§8.4 steps 2, 3, 5)", () => {
	test("fromSelf events are dropped", async () => {
		const { receive, submits } = await rig();
		const outcome = await receive(dmEvent({ messageId: "m1", fromSelf: true }));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
	});

	test("bot events are dropped when allowBots is off", async () => {
		const { receive, submits } = await rig();
		const outcome = await receive(
			dmEvent({ messageId: "m1", sender: { id: "bot-1", name: "Bot", isBot: true } }),
		);
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
	});

	test("bot events are admitted when allowBots is on", async () => {
		const { receive, submits } = await rig({
			channels: {
				loop: {
					dm: "allowlist",
					allow: [{ sender: "100000001", user: "alice" }],
					allowBots: true,
				},
			},
		});
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "admitted" });
		expect(submits()).toHaveLength(1);
	});

	test("an unknown DM sender is dropped (allowlist policy, no reply in Task 3)", async () => {
		const { receive, submits, channel } = await rig();
		const outcome = await receive(
			dmEvent({ messageId: "m1", sender: { id: "999", name: "Nobody" } }),
		);
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
		expect(channel.sent).toEqual([]);
	});

	test("a duplicate message id (already committed) is dropped", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1" }));
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(1);
	});

	test("the same message id delivered CONCURRENTLY admits exactly once (Review Focus 1)", async () => {
		const { receive, submits } = await rig();
		const [a, b] = await Promise.all([
			receive(dmEvent({ messageId: "m1" })),
			receive(dmEvent({ messageId: "m1" })),
		]);
		const outcomes = [a.outcome, b.outcome].sort();
		expect(outcomes).toEqual(["admitted", "dropped"]);
		expect(submits()).toHaveLength(1);
	});

	test("a group event is dropped (Task 3 admits DMs only)", async () => {
		const { receive, submits } = await rig();
		const outcome = await receive(
			dmEvent({
				messageId: "m1",
				chat: { chatId: "-100000000002", chatType: "group", title: "Dev" },
			}),
		);
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
	});
});

describe("pipeline: album merge (§8.4 step 6)", () => {
	// The merged batch submits on the window's close TIMER (real 1500 ms
	// — the pipeline's seam owns real timing); the tests await it.
	const WINDOW_CLOSE_MS = ALBUM_WINDOW_MS + 200;

	test("three events sharing a groupId within 1500 ms merge into one submit", async () => {
		const { receive, submits } = await rig();
		const events = [1, 2, 3].map((n) =>
			dmEvent({ messageId: `m${n}`, groupId: "album-1", text: `part ${n}` }),
		);
		const outcomes = await Promise.all(events.map((event) => receive(event)));
		expect(outcomes.every((o) => o.outcome === "admitted")).toBe(true);
		expect(submits()).toHaveLength(0);
		await sleep(WINDOW_CLOSE_MS);
		expect(submits()).toHaveLength(1);
	});

	test("album parts are joined in order", async () => {
		const { receive, submits } = await rig();
		const events = [1, 2, 3].map((n) =>
			dmEvent({ messageId: `m${n}`, groupId: "album-1", text: `part ${n}` }),
		);
		await Promise.all(events.map((event) => receive(event)));
		await sleep(WINDOW_CLOSE_MS);
		const parts = submits()[0]?.parts;
		expect(parts).toEqual([
			{ type: "text", text: "part 1\npart 2\npart 3" },
		]);
	});

	test("a groupId arriving AFTER the merge window submits separately", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1", groupId: "album-1", text: "first" }));
		await sleep(WINDOW_CLOSE_MS);
		await receive(dmEvent({ messageId: "m2", groupId: "album-1", text: "late" }));
		await sleep(WINDOW_CLOSE_MS);
		expect(submits()).toHaveLength(2);
	});

	test("a plain follow-up message does not join a closed album", async () => {
		const { receive, submits } = await rig();
		await receive(dmEvent({ messageId: "m1", groupId: "album-1", text: "a" }));
		await sleep(WINDOW_CLOSE_MS);
		await receive(dmEvent({ messageId: "m2", text: "plain" }));
		expect(submits()).toHaveLength(2);
	});

	test("flushAlbums submits a collecting album without waiting for the window (the stopIntake path)", async () => {
		const origins = new Map();
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-pipeline-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice", admin: true }] });
		const parsed = parseGatewayConfig({
			channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
		}).channels.loop;
		if (parsed === undefined || "failed" in parsed) {
			throw new Error("test setup: loop channel must parse");
		}
		const pipeline = createPipeline({
			host,
			channel: fakeChannel(),
			stateDir: dir,
			log: silentLog(),
			origins,
		});
		// The album collects (both events admitted, no submit yet — the
		// 1500 ms window is still open).
		const first = await pipeline("loop", dmEvent({ messageId: "m1", groupId: "album-1", text: "part 1" }), parsed);
		const second = await pipeline("loop", dmEvent({ messageId: "m2", groupId: "album-1", text: "part 2" }), parsed);
		expect([first.outcome, second.outcome]).toEqual(["admitted", "admitted"]);
		// The flush (what stopIntake runs): the merged batch submits NOW,
		// no timer fired, no window wait.
		await pipeline.flushAlbums();
		const submits = host.calls
			.filter((call) => call.method === "conversations.submit")
			.map((call) => call.args[1] as readonly SubmissionInputPart[]);
		expect(submits).toHaveLength(1);
		expect(submits[0]).toEqual([
			{ type: "text", text: "part 1\npart 2" },
		]);
		// The flushed album never double-submits when its (cleared) timer
		// slot would have fired: flushing is terminal per group.
		await sleep(WINDOW_CLOSE_MS);
		const after = host.calls.filter(
			(call) => call.method === "conversations.submit",
		).length;
		expect(after).toBe(1);
	});
});

describe("engine stopIntake: the album flush (Review finding 1)", () => {
	test("stopIntake submits a collecting album — no timer, no loss at shutdown", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-pipeline-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({
			storesDir: dir,
			users: [{ user: "alice", admin: true }],
		});
		await host.stores.settings.set({
			channels: {
				loop: {
					dm: "allowlist",
					allow: [{ sender: "100000001", user: "alice" }],
				},
			},
		});
		// A REAL channel adapter whose start captures the context (the
		// engine hands its receive through the supervisor's makeContext).
		let adapterContext: ChannelContext | undefined;
		const channel: ChannelContribution = {
			id: "loop",
			label: "Loop",
			capabilities: {
				chatTypes: ["dm"],
				maxMessageLength: 200,
				format: "markdown",
			},
			configured: () => ({ status: "ready" }),
			start: async (ctx) => {
				adapterContext = ctx;
			},
			send: async () => ({ messageIds: [] }),
		};
		const engine = createEngine(host);
		await engine.start({
			channels: [{ extension: "fixture", channel }],
			signal: new AbortController().signal,
		});
		if (adapterContext === undefined) {
			throw new Error("test setup: the adapter never received a context");
		}
		// The album collects (both events admitted; the 1500 ms window
		// stays open — nothing waits for it).
		const event = (n: number): InboundEvent => ({
			messageId: `m${n}`,
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: `part ${n}`,
			groupId: "album-1",
		});
		const outcomes = await Promise.all([
			adapterContext.receive(event(1)),
			adapterContext.receive(event(2)),
		]);
		expect(outcomes.map((o) => o.outcome)).toEqual(["admitted", "admitted"]);
		// Nothing submitted yet (the window holds the merged batch).
		expect(
			host.calls.filter((c) => c.method === "conversations.submit").length,
		).toBe(0);
		// The engine's stopIntake flushes: the merged submission lands NOW.
		await engine.stopIntake();
		const submits = host.calls
			.filter((c) => c.method === "conversations.submit")
			.map((c) => c.args[1] as readonly SubmissionInputPart[]);
		expect(submits).toHaveLength(1);
		expect(submits[0]).toEqual([
			{ type: "text", text: "part 1\npart 2" },
		]);
		await engine.stop();
	});
});

describe("pipeline: submit-error outcomes (M12)", () => {
	test("UnservedModelError replies the pinned notice and resolves dropped", async () => {
		const { host, receive, channel, submits } = await rig();
		const error = namedError("UnservedModelError", "model gone", {
			// The runtime error carries the structured ref ({provider, modelId}).
			ref: { provider: "faux", modelId: "m2" },
		});
		failNextSubmit(host, error);
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.text).toBe(
			"The model faux/m2 is not available. Use /model to pick another.",
		);
	});

	test("a ConversationOpError replies a short notice and resolves dropped", async () => {
		const { host, receive, channel, submits } = await rig();
		const error = namedError("ConversationOpError", "bad op", {
			body: { error: "invalid_field", field: "name" },
			status: 400,
		});
		failNextSubmit(host, error);
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(submits()).toHaveLength(0);
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.text.length).toBeGreaterThan(0);
	});

	test("an unexpected throw REJECTS receive and releases the seen id", async () => {
		const { host, receive, submits } = await rig();
		const error = new Error("synthetic engine failure");
		failNextSubmit(host, error);
		await expect(receive(dmEvent({ messageId: "m1" }))).rejects.toThrow(
			"synthetic engine failure",
		);
		expect(submits()).toHaveLength(0);
		// The released id is claimable again (the platform redelivers).
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "admitted" });
	});

	test("the seen id is committed BEFORE the notice (M12 ordering)", async () => {
		const { host, receive, channel } = await rig();
		// The notice send REJECTS: the idempotency record must already be
		// durable (commit-before-notice) — a redelivery after this
		// failure must dedupe to a no-op, never a second submit+notice.
		(channel as { send: unknown }).send = async () => {
			throw new Error("synthetic send failure");
		};
		failNextSubmit(
			host,
			namedError("UnservedModelError", "model gone", {
				ref: { provider: "faux", modelId: "m2" },
			}),
		);
		const outcome = await receive(dmEvent({ messageId: "m1" }));
		expect(outcome).toEqual({ outcome: "dropped" });
		// The redelivery dedupes (the committed id won despite the failed
		// notice): the failure patch is DISARMED by then (it fires once),
		// so a re-submission would have recorded a submit — zero recorded
		// submits proves the committed id blocked it.
		const redelivered = await receive(dmEvent({ messageId: "m1" }));
		expect(redelivered).toEqual({ outcome: "dropped" });
		const attempts = host.calls.filter(
			(c) => c.method === "conversations.submit",
		).length;
		expect(attempts).toBe(0);
	});

	test("a submit-error reply goes to the event's chat", async () => {
		const { host, receive, channel } = await rig();
		failNextSubmit(
			host,
			namedError("UnservedModelError", "model gone", {
				ref: { provider: "faux", modelId: "m2" },
			}),
		);
		await receive(dmEvent({ messageId: "m1" }));
		expect(channel.sent[0]?.chat).toEqual({
			chatId: "100000001",
			chatType: "dm",
		});
	});
});
