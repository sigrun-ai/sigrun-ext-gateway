/**
 * The per-channel delivery worker (spec §8.6): one in-flight send per
 * channel, the retry ladder (1 s / 5 s / 30 s then failed), the error
 * classification mapping, the chat-gone dead-marking, and the 60 s send
 * timeout (Review Focus 2 — a hung adapter call classifies transient
 * and never wedges the worker).
 *
 * Tests own their literals; timers are a virtual clock the tests step.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
	ChannelContribution,
	ChatRef,
	OutboundMessage,
	SendReceipt,
} from "@sigrun/sigrun/extension";
import { Ledger } from "../src/state/ledger.js";
import { DeliveryWorker } from "../src/outbound/delivery.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";

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

/** One send recorded by the fake adapter. */
interface SentMessage {
	readonly text: string;
}

/** The fake channel adapter: recordable sends, fail modes, hangs. */
interface FakeChannel extends ChannelContribution {
	readonly sent: readonly SentMessage[];
	/** Fail every send with an error classified as `kind`. */
	failWith(kind: "transient" | "permanent" | "chat_gone"): void;
	/** Make the next send never resolve (the 60 s timeout case). */
	hangNext(): void;
}

function fakeChannel(over: Partial<ChannelContribution> = {}): FakeChannel {
	const state = {
		sent: [] as SentMessage[],
		pending: undefined as "transient" | "permanent" | "chat_gone" | undefined,
		hang: false,
	};
	const adapter: FakeChannel = {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm"],
			maxMessageLength: 200,
			format: "markdown",
		},
		configured: () => ({ status: "ready" as const }),
		start: async () => {},
		send: async (message: OutboundMessage): Promise<SendReceipt> => {
			if (state.hang) {
				state.hang = false;
				await new Promise<never>(() => {});
			}
			if (state.pending !== undefined) {
				const kind = state.pending;
				state.pending = undefined;
				const error = new Error(`loop: ${kind} failure`);
				// The error carries the classification the engine reads.
				(error as { kind?: string }).kind = kind;
				throw error;
			}
			state.sent.push({ text: message.text });
			return { messageIds: [`loop-${state.sent.length}`] };
		},
		classifyError: (error: unknown): "transient" | "permanent" | "chat_gone" => {
			const kind = (error as { kind?: string }).kind;
			return kind === "permanent" || kind === "chat_gone" ? kind : "transient";
		},
		failWith: (kind) => {
			state.pending = kind;
		},
		hangNext: () => {
			state.hang = true;
		},
		sent: state.sent,
		...over,
	};
	return adapter;
}

/** The virtual clock: tests step time, timers fire in order. */
function virtualClock(): {
	now(): number;
	advance(ms: number): Promise<void>;
	setTimer(fn: () => void, ms: number): () => void;
} {
	let current = 0;
	const timers: { readonly at: number; fire(): void }[] = [];
	const setTimer = (fn: () => void, ms: number): (() => void) => {
		const timer = { at: current + ms, fire: fn };
		timers.push(timer);
		return () => {
			const index = timers.indexOf(timer);
			if (index !== -1) timers.splice(index, 1);
		};
	};
	// The ledger's marks ride REAL fs writes (JsonFile's atomic staging):
	// a settle is a handful of real macrotask hops, enough for the local-
	// disk writes and the void-marked retry chains to land. Timers NEVER
	// fire during a settle (the virtual clock owns them).
	const settle = async (): Promise<void> => {
		for (let hop = 0; hop < 25; hop++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	};
	const advance = async (ms: number): Promise<void> => {
		// Settle first: a kick() right before advance() arms its timers
		// only after the ledger's queued marks land.
		await settle();
		const target = current + ms;
		for (;;) {
			// The earliest timer at or before the target fires first.
			const next = timers
				.filter((timer) => timer.at <= target)
				.sort((a, b) => a.at - b.at)[0];
			if (next === undefined) break;
			current = Math.max(current, next.at);
			const index = timers.indexOf(next);
			timers.splice(index, 1);
			next.fire();
			// The fired callback's own async chain (send → mark → maybe arm
			// the next timer) must land before the next scan.
			await settle();
		}
		current = target;
		await settle();
	};
	return { now: () => current, advance, setTimer };
}

type SetTimer = ReturnType<typeof virtualClock>["setTimer"];

/** The delivery rig: ledger, bindings, worker, virtual clock. */
interface Rig {
	readonly channel: FakeChannel;
	readonly ledger: Ledger;
	readonly bindings: BindingStore;
	readonly worker: DeliveryWorker;
	readonly clock: ReturnType<typeof virtualClock>;
	readonly drain: (deadlineMs: number) => Promise<void>;
}

async function rig(channel: FakeChannel = fakeChannel()): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-delivery-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const clock = virtualClock();
	const ledger = new Ledger(join(dir, "ledger.json"), { now: clock.now });
	const bindings = new BindingStore(join(dir, "bindings.json"), {
		now: clock.now,
	});
	await bindings.bind(KEY, 1, CHAT);
	const worker = new DeliveryWorker(channel, ledger, {
		bindings,
		timeoutMs: 60_000,
		delays: [1000, 5000, 30000],
		setTimer: clock.setTimer,
		log: silentLog(),
		now: clock.now,
	});
	return {
		channel,
		ledger,
		bindings,
		worker,
		clock,
		drain: (deadlineMs: number) => worker.drain(deadlineMs),
	};
}

/** Enqueue one final entry for the rig's chat. */
async function enqueueFinal(rig: Rig, text = "hello"): Promise<string> {
	const entry = await rig.ledger.enqueue({
		channel: "loop",
		bindingKey: KEY,
		chat: CHAT,
		kind: "final",
		message: { chat: CHAT, text },
	});
	if (entry === undefined) throw new Error("test setup: enqueue deduped");
	return entry.id;
}

describe("DeliveryWorker happy path", () => {
	test("kick delivers one pending entry in order", async () => {
		const harness = await rig();
		await enqueueFinal(harness, "one");
		await enqueueFinal(harness, "two");
		harness.worker.kick();
		await harness.clock.advance(0);
		expect(harness.channel.sent.map((m) => m.text)).toEqual(["one", "two"]);
		await harness.worker.stop();
	});

	test("drain sends everything pending then resolves", async () => {
		const harness = await rig();
		await enqueueFinal(harness, "one");
		await enqueueFinal(harness, "two");
		// The deadline is ABSOLUTE clock ms (the worker's `now`): the
		// virtual clock reads 0, so a deadline of 5000 is 5 s of room.
		await harness.drain(5000);
		expect(harness.channel.sent).toHaveLength(2);
		await harness.worker.stop();
	});
});

describe("DeliveryWorker retry ladder (spec §8.6)", () => {
	test("transient retries at 1 s, 5 s, 30 s, then failed", async () => {
		const harness = await rig();
		const id = await enqueueFinal(harness);
		// Fail the first THREE attempts (the ladder), succeed the fourth.
		let failures = 3;
		const channel = harness.channel;
		const original = channel.send.bind(channel);
		channel.send = (async (message: OutboundMessage) => {
			if (failures > 0) {
				failures--;
				channel.failWith("transient");
			}
			return original(message);
		}) as typeof channel.send;
		harness.worker.kick();
		// Attempt 1 fails → retry armed at 1 s.
		await harness.clock.advance(1000);
		expect(harness.channel.sent).toHaveLength(0);
		// Attempt 2 fails → retry armed at 5 s.
		await harness.clock.advance(5000);
		expect(harness.channel.sent).toHaveLength(0);
		// Attempt 3 fails → retry armed at 30 s; that one succeeds.
		await harness.clock.advance(30_000);
		expect(harness.channel.sent.map((m) => m.text)).toEqual(["hello"]);
		// The entry is delivered (attempts: 4 = initial + 3 retries).
		expect(harness.ledger.failedSince(0)).toBe(0);
		void id;
		await harness.worker.stop();
	});

	test("a fourth transient failure marks the entry failed (it feeds health)", async () => {
		const harness = await rig();
		await enqueueFinal(harness);
		let failures = 4;
		const channel = harness.channel;
		const original = channel.send.bind(channel);
		channel.send = (async (message: OutboundMessage) => {
			if (failures > 0) {
				failures--;
				channel.failWith("transient");
			}
			return original(message);
		}) as typeof channel.send;
		harness.worker.kick();
		await harness.clock.advance(1000);
		await harness.clock.advance(5000);
		await harness.clock.advance(30_000);
		// The ladder is exhausted: the entry is failed, nothing sends.
		expect(harness.channel.sent).toHaveLength(0);
		expect(harness.ledger.failedSince(0)).toBe(1);
		await harness.worker.stop();
	});

	test("permanent fails at once (no retries)", async () => {
		const harness = await rig();
		await enqueueFinal(harness);
		harness.channel.failWith("permanent");
		harness.worker.kick();
		await harness.clock.advance(0);
		expect(harness.channel.sent).toHaveLength(0);
		expect(harness.ledger.failedSince(0)).toBe(1);
		// No retry timer armed: advancing the whole ladder changes nothing.
		await harness.clock.advance(60_000);
		expect(harness.ledger.failedSince(0)).toBe(1);
		await harness.worker.stop();
	});
});

describe("DeliveryWorker chat_gone", () => {
	test("chat_gone marks the binding dead and skips the entry", async () => {
		const harness = await rig();
		await enqueueFinal(harness);
		harness.channel.failWith("chat_gone");
		harness.worker.kick();
		await harness.clock.advance(0);
		expect(harness.channel.sent).toHaveLength(0);
		expect(harness.bindings.get(KEY)?.dead).toBe(true);
		// No retry: the entry is out of the queue.
		await harness.clock.advance(60_000);
		expect(harness.channel.sent).toHaveLength(0);
		await harness.worker.stop();
	});
});

describe("DeliveryWorker hung send (Review Focus 2)", () => {
	test("a send exceeding 60 s classifies transient; the next entry still sends", async () => {
		const harness = await rig();
		await enqueueFinal(harness, "first");
		await enqueueFinal(harness, "second");
		harness.channel.hangNext();
		harness.worker.kick();
		// The hung send is in flight; at 60 s it times out (transient).
		await harness.clock.advance(60_000);
		// The retry lands at +1 s and succeeds; the second entry follows.
		await harness.clock.advance(1000);
		expect(harness.channel.sent.map((m) => m.text)).toEqual([
			"first",
			"second",
		]);
		await harness.worker.stop();
	});
});

describe("DeliveryWorker recovered entries", () => {
	test("a recovered entry is resent with the marker prefix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-delivery-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const clock = virtualClock();
		// The pre-boot ledger: one entry left in `attempting` (the crash).
		const before = new Ledger(join(dir, "ledger.json"), { now: () => 0 });
		const entry = await before.enqueue({
			channel: "loop",
			bindingKey: KEY,
			chat: CHAT,
			kind: "final",
			message: { chat: CHAT, text: "pre-crash" },
		});
		await before.mark(entry!.id, "attempting");
		// The post-boot pair recovers and delivers.
		const ledger = new Ledger(join(dir, "ledger.json"), { now: () => 1000 });
		await ledger.recoverAfterRestart();
		const bindings = new BindingStore(join(dir, "bindings.json"), {
			now: clock.now,
		});
		await bindings.bind(KEY, 1, CHAT);
		const channel = fakeChannel();
		const worker = new DeliveryWorker(channel, ledger, {
			bindings,
			timeoutMs: 60_000,
			delays: [1000, 5000, 30000],
			setTimer: clock.setTimer,
			log: silentLog(),
			now: clock.now,
		});
		worker.kick();
		await clock.advance(0);
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.text).toBe(
			"(resent after restart)\npre-crash",
		);
		await worker.stop();
	});
});

describe("DeliveryWorker drain ownership (review fix 3)", () => {
	test("drain takes the queue: a kick during a drain is a no-op (no second loop)", async () => {
		const harness = await rig();
		await enqueueFinal(harness, "one");
		// A slow first send holds the drain; a concurrent kick must not
		// start a second loop (a duplicate send).
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const channel = harness.channel;
		const original = channel.send.bind(channel);
		let sends = 0;
		channel.send = (async (message: OutboundMessage) => {
			sends++;
			if (sends === 1) await gate;
			return original(message);
		}) as typeof channel.send;
		const draining = harness.worker.drain(1_000_000_000);
		// The drain is in flight (the virtual clock never advances; the
		// send gate holds it). A kick while draining must be a no-op.
		harness.worker.kick();
		release();
		await draining;
		expect(harness.channel.sent.map((m) => m.text)).toEqual(["one"]);
		await harness.worker.stop();
	});

	test("drain cancels the armed retry and re-pulls the entry directly (no timer race)", async () => {
		const harness = await rig();
		await enqueueFinal(harness, "one");
		// Attempt 1 fails transient → a retry timer is armed at +1 s.
		harness.channel.failWith("transient");
		harness.worker.kick();
		await harness.clock.advance(0);
		expect(harness.channel.sent).toHaveLength(0);
		// The drain takes ownership: the retry timer is cancelled, the
		// re-pended entry sends directly (no duplicate via the timer).
		const sentBefore = harness.channel.sent.length;
		await harness.drain(1_000_000);
		expect(harness.channel.sent.slice(sentBefore).map((m) => m.text)).toEqual([
			"one",
		]);
		// Advancing the (cancelled) retry timer changes nothing.
		await harness.clock.advance(60_000);
		expect(harness.channel.sent.slice(sentBefore)).toHaveLength(1);
		await harness.worker.stop();
	});
});

describe("DeliveryWorker ledger-mark failures (review fix 4)", () => {
	test("a failing attempting mark logs and parks the entry (no send, no silent stall)", async () => {
		const harness = await rig();
		const id = await enqueueFinal(harness, "one");
		// The ledger's NEXT mark rejects: sendOne must log it and not send.
		const errors: string[] = [];
		const log = {
			info: () => {},
			warn: (msg: string) => errors.push(msg),
			error: (msg: string, _e?: unknown) => errors.push(msg),
			debug: () => {},
			once: () => {},
		};
		const worker = new DeliveryWorker(harness.channel, harness.ledger, {
			bindings: harness.bindings,
			timeoutMs: 60_000,
			delays: [1000, 5000, 30000],
			setTimer: harness.clock.setTimer,
			now: harness.clock.now,
			log,
		});
		const original = harness.ledger.mark.bind(harness.ledger);
		let failed = false;
		harness.ledger.mark = (async (mid: string, state: string, receipt?: readonly string[]) => {
			if (!failed && state === "attempting") {
				failed = true;
				throw new Error("ledger unavailable");
			}
			return original(mid, state as Parameters<typeof original>[1], receipt);
		}) as typeof harness.ledger.mark;
		worker.kick();
		await harness.clock.advance(0);
		// No send ran (the entry was never marked attempting — sending an
		// unmarked entry would double-send after recovery).
		expect(harness.channel.sent).toHaveLength(0);
		// The failure was logged (never a silent empty catch).
		expect(errors.some((line) => line.includes("ledger unavailable"))).toBe(true);
		// The worker is not wedged: the entry stays pending and a later
		// kick (the ledger recovered) delivers it.
		harness.ledger.mark = original;
		worker.kick();
		await harness.clock.advance(0);
		expect(harness.channel.sent.map((m) => m.text)).toEqual(["one"]);
		void id;
		await worker.stop();
	});
});

describe("DeliveryWorker stop", () => {
	test("stop cancels pending retries and resolves drain", async () => {
		const harness = await rig();
		await enqueueFinal(harness);
		harness.channel.failWith("transient");
		harness.worker.kick();
		await harness.clock.advance(0);
		await harness.worker.stop();
		// The retry timer is gone: advancing time sends nothing.
		await harness.clock.advance(120_000);
		expect(harness.channel.sent).toHaveLength(0);
	});
});
