/**
 * Supervisor + engine health (Task 2, spec §8.12): the per-channel
 * backoff state machine over fake timers, and `engine.health()`
 * degraded derivation (300 000 ms in backoff/failed, or the ledger's
 * failed-in-last-hour count — 0 until Task 5 through the
 * `failedRecently` dependency).
 *
 * Fake timers: `now()` a mutable clock, `random()` pinned to 0 (every
 * delay is exactly the pinned 1000-doubling sequence — jitter's ±
 * range is asserted separately with a non-zero random), `setTimer`
 * records every `(fn, ms)` and hands back a cancel that also records.
 *
 * Tests own their literals: synthetic senders, example.invalid, no
 * real tokens.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
	ChannelContext,
	ChannelContribution,
	GatewayEngineContext,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { createEngine, type EngineInternals } from "../src/engine.js";
import type { GatewayEngine } from "@sigrun/sigrun/extension";
import { createPipeline } from "../src/inbound/pipeline.js";

// ---------------------------------------------------------------------------
// Fake clock/timer/random
// ---------------------------------------------------------------------------

/** One recorded scheduled callback (what the engine asked `setTimer` for). */
interface Scheduled {
	fn: () => void;
	ms: number;
	fired: boolean;
}

/** The fake timer world: a mutable clock, pinned random, recorded timers. */
class FakeTime {
	now = 0;
	/** The injected random value (jitter); 0 by default (no jitter). */
	random = 0;
	readonly scheduled: Scheduled[] = [];
	/** Injected `setTimer`: records and hands back a cancelling handle. */
	readonly setTimer = (fn: () => void, ms: number): (() => void) => {
		const entry: Scheduled = { fn, ms, fired: false };
		this.scheduled.push(entry);
		return () => {
			entry.fired = true;
		};
	};
	/**
	 * Advance the clock to the NEXT unfired timer's deadline and fire it
	 * alone — the exact one-step driver the doubling-sequence test needs
	 * (a bulk `advance` past the cap would cascade retries).
	 */
	async fireNext(): Promise<number> {
		const pending = this.scheduled.find((entry) => !entry.fired);
		if (pending === undefined) throw new Error("fireNext: nothing scheduled");
		const target = pending.ms;
		this.now = Math.max(this.now, target);
		pending.fired = true;
		pending.fn();
		await flushMicrotasks();
		return target;
	}

	/** Advance the clock and fire every scheduled timer due at/under it. */
	async advance(ms: number): Promise<void> {
		this.now += ms;
		// Fire each due timer exactly once (a fired callback may schedule
		// the next retry — it becomes due later, not re-fired here).
		for (let pass = 0; pass < 8; pass++) {
			const due = this.scheduled.filter(
				(entry) => !entry.fired && entry.ms <= this.now,
			);
			if (due.length === 0) return;
			for (const entry of due) entry.fired = true;
			for (const entry of due) entry.fn();
			await flushMicrotasks();
		}
	}
}

/** Let queued promise callbacks run (a start retry is async). */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// The fake adapter
// ---------------------------------------------------------------------------

/** The fake adapter's test controls. */
interface FakeAdapter extends ChannelContribution {
	/** The readiness `configured()` returns. */
	readiness: { status: "ready" | "not_configured"; detail?: string };
	/** When true, the next `start` rejects with the synthetic error. */
	failNextStart: boolean;
	/** When true, EVERY `start` rejects (persistent-failure mode — the
	 *  doubling/health tests need retries to keep failing). */
	failEveryStart: boolean;
	/** Every context `start` was handed (one per attempt). */
	readonly contexts: ChannelContext[];
	/** The most recent handed context's `fail` (for the ctx.fail test). */
	lastContext(): ChannelContext | undefined;
}

function fakeAdapter(id: string): FakeAdapter {
	const adapter: FakeAdapter = {
		readiness: { status: "ready" },
		failNextStart: false,
		failEveryStart: false,
		contexts: [],
		id,
		label: `Fake ${id}`,
		capabilities: {
			chatTypes: ["dm"],
			maxMessageLength: 100,
			format: "markdown",
		},
		configured: () => adapter.readiness,
		start: async (ctx) => {
			adapter.contexts.push(ctx);
			if (adapter.failEveryStart || adapter.failNextStart) {
				adapter.failNextStart = false;
				throw new Error(`synthetic start failure: ${id}`);
			}
		},
		send: async () => ({ messageIds: [] }),
		lastContext: () => adapter.contexts.at(-1),
	};
	return adapter;
}

/** Build the `start` ctx over one fake-time world. */
function engineCtx(
	channels: readonly { extension: string; channel: ChannelContribution }[],
): GatewayEngineContext {
	return {
		channels,
		signal: new AbortController().signal,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function fakeHost(channels: Record<string, unknown> = { loop: {} }): Promise<FakeHost> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-supervisor-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir });
	// Supervision's enablement read: the engine reads settings ONCE at
	// start (restart-required field). Default: loop enabled with every
	// config default.
	await host.stores.settings.set({ channels });
	return host;
}

// ---------------------------------------------------------------------------
// The engine: supervision
// ---------------------------------------------------------------------------

describe("supervision (createEngine + fake timers)", () => {
	test("a not_configured adapter is never started", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		adapter.readiness = { status: "not_configured", detail: "no token" };
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		expect(adapter.contexts).toEqual([]);
		// No retry was scheduled either: not_configured is terminal.
		expect(time.scheduled.length).toBe(0);
		// The status route's read: not_configured with the detail.
		expect(engine.status().channels.loop?.state).toBe("not_configured");
		await engine.stop();
	});

	test("a rejected start enters backoff with delays 1000, 2000, 4000 … capped 300000", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		adapter.failEveryStart = true;
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		// First attempt failed synchronously into backoff (one start ran).
		expect(adapter.contexts.length).toBe(1);
		expect(engine.status().channels.loop?.state).toBe("backoff");
		// The retry delay: 1000 ms exactly (random() pinned to 0).
		expect(time.scheduled.map((entry) => entry.ms)).toEqual([1000]);
		// Every subsequent failure doubles: 1000, 2000, 4000, 8000, then
		// 16000, 32000, 64000, 128000, 256000, and the cap holds at 300000
		// for every retry after (fired one at a time so the clock never
		// runs past a due retry and cascades).
		const delays: number[] = [];
		for (const expected of [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
			const fired = await time.fireNext();
			expect(fired).toBe(expected);
			delays.push(fired);
			// Each fired retry failed (failEveryStart) and scheduled the next.
		}
		// The last fired retry scheduled one more (the loop continues at
		// the cap); the EXPECTED list stops at the 11th delay, the actual
		// carries the 12th — so compare the prefix.
		expect(time.scheduled.map((entry) => entry.ms).slice(0, delays.length))
			.toEqual(delays);
		// 12 attempts: the initial failure + 11 retries (…256000 → the cap
		// → the cap again).
		expect(adapter.contexts.length).toBe(12);
		await engine.stop();
	});

	test("jitter comes from the injected random() (delay within [ms, ms + jitterMax])", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		adapter.failNextStart = true;
		const time = new FakeTime();
		time.random = 0.5;
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		const first = time.scheduled[0]?.ms;
		// With random() = 0.5 the first delay sits strictly between the
		// pinned 1000 and the 2000 ceiling (the doubled base) — jitter
		// NEVER shortens the backoff below the pinned floor.
		expect(first).toBeGreaterThan(1000);
		expect(first).toBeLessThanOrEqual(2000);
		await engine.stop();
	});

	test("600000 ms running resets the backoff delay", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		expect(engine.status().channels.loop?.state).toBe("running");
		// Run long enough to arm the reset, then fail through ctx.fail.
		await time.advance(600000);
		const ctx = adapter.lastContext();
		if (ctx === undefined) throw new Error("no context was handed to start");
		ctx.fail(new Error("synthetic post-connect failure"));
		expect(engine.status().channels.loop?.state).toBe("backoff");
		expect(time.scheduled.map((entry) => entry.ms)).toEqual([1000]);
		await engine.stop();
	});

	test("a fail-restart cycle reuses the channel's one pipeline", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		let constructions = 0;
		const engine = createEngine(host, {
			timers: fakeTimers(time),
			pipelineFactory: (pipelineDeps) => {
				constructions++;
				return createPipeline(pipelineDeps);
			},
		});
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		adapter.lastContext()?.fail(new Error("synthetic restart"));
		await time.advance(1000);
		expect(adapter.contexts).toHaveLength(2);
		expect(constructions).toBe(1);
		await engine.stop();
	});

	test("delivery and terminal-failure outcomes update status counts", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		const internals = engine as GatewayEngine & EngineInternals;
		const toolDeps = internals.toolDeps();
		const chat = { chatId: "100000001", chatType: "dm" } as const;
		await toolDeps.bindings.bind("loop:default:dm:100000001", 7, chat);
		await toolDeps.ledger.enqueue({
			channel: "loop",
			bindingKey: "loop:default:dm:100000001",
			chat,
			kind: "final",
			message: { chat, text: "delivered" },
		});
		await toolDeps.ledger.enqueue({
			channel: "loop",
			bindingKey: "loop:default:dm:100000001",
			chat,
			kind: "final",
			message: { chat, text: "failed" },
		});
		adapter.send = async (message) => {
			if (message.text === "failed") {
				const error = new Error("synthetic permanent failure");
				(error as Error & { kind: string }).kind = "permanent";
				throw error;
			}
			return { messageIds: ["synthetic-receipt"] };
		};
		adapter.classifyError = (error) =>
			(error as { kind?: string }).kind === "permanent" ? "permanent" : "transient";
		// Enqueue-after-start does not implicitly kick every worker;
		// settled/tool paths own that poke. This test drives the same seam.
		await internals.settle(
			{
				conversationId: 99 as import("@earendil-works/pi-durable").ConversationId,
				inputs: [],
				inputTexts: [],
				outcome: { status: "unanswered", reason: "test kick" },
			},
			{} as import("@sigrun/sigrun/extension").MemoryEventApi,
			{} as import("@sigrun/sigrun/extension").HandlerContext,
		);
		for (let attempt = 0; attempt < 20; attempt++) {
			const counts = engine.status().channels.loop?.counts;
			if (counts?.delivered === 1 && counts.failed === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(engine.status().channels.loop?.counts).toMatchObject({
			delivered: 1,
			failed: 1,
		});
		await engine.stop();
	});

	test("ctx.fail after running enters backoff, and the engine recovers to running", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		const ctx = adapter.lastContext();
		if (ctx === undefined) throw new Error("no context was handed to start");
		ctx.fail(new Error("synthetic post-connect failure"));
		expect(engine.status().channels.loop?.state).toBe("backoff");
		// The retry succeeds (start resolves) → running again.
		await time.advance(1000);
		expect(engine.status().channels.loop?.state).toBe("running");
		expect(adapter.contexts.length).toBe(2);
		await engine.stop();
	});

	test("stop() stops the adapter, settles to stopped, and cancels a pending retry", async () => {
		const host = await fakeHost();
		let stopped = 0;
		const adapter = fakeAdapter("loop");
		adapter.stop = async () => {
			stopped++;
		};
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		// Force a pending backoff retry, then stop: the retry timer must
		// be CANCELLED (fired stays false forever — advance past its
		// deadline and no new start attempt runs).
		const ctx = adapter.lastContext();
		if (ctx === undefined) throw new Error("no context was handed to start");
		ctx.fail(new Error("synthetic post-connect failure"));
		expect(engine.status().channels.loop?.state).toBe("backoff");
		expect(time.scheduled.length).toBe(1);
		await engine.stop();
		expect(stopped).toBe(1);
		expect(engine.status().channels.loop?.state).toBe("stopped");
		// The retry never fires even far past its deadline: the cancel
		// disarmed the loop and no new context arrives.
		const attempts = adapter.contexts.length;
		await time.advance(600_000);
		expect(adapter.contexts.length).toBe(attempts);
	});

	test("status carries since/lastError/counts and the channel id keying", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		adapter.failNextStart = true;
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		const channel = engine.status().channels.loop;
		expect(channel).toMatchObject({
			state: "backoff",
			lastError: expect.stringContaining("synthetic start failure"),
			counts: { admitted: 0, dropped: 0, delivered: 0, failed: 0 },
		});
		expect(typeof channel?.since).toBe("number");
		await engine.stop();
	});

	test("counts track admitted/dropped through ctx.receive until Task 3", async () => {
		// Until Task 3's pipeline lands, receive resolves "dropped"; the
		// supervisor still counts it (the counts surface is live now).
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		const ctx = adapter.lastContext();
		if (ctx === undefined) throw new Error("no context was handed to start");
		const outcome = await ctx.receive({
			messageId: "100000001",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000002" },
			text: "hello",
		});
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(engine.status().channels.loop?.counts.dropped).toBe(1);
		await engine.stop();
	});
});

// ---------------------------------------------------------------------------
// Health (spec §8.12)
// ---------------------------------------------------------------------------

describe("engine.health() (§8.12)", () => {
	test("a config-failed channel degrades health only after 300000 ms of failed dwell (§8.12)", async () => {
		const host = await fakeHost();
		// The settings store returns a config whose channel block is
		// malformed: the channel is {failed} and never started — a static
		// `failed` row whose §8.12 dwell the health read must count.
		await host.stores.settings.set({
			channels: { loop: { dm: "wrong" } },
		});
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		expect(adapter.contexts).toEqual([]);
		expect(engine.status().channels.loop?.state).toBe("failed");
		expect(engine.status().channels.loop?.detail).toContain("dm");
		// §8.12's "in backoff/failed for over 5 minutes": the static failed
		// row degrades after 300000 ms of dwell, not immediately.
		expect(engine.health()).toBe("ok");
		await time.advance(300_000);
		expect(engine.health()).toBe("ok");
		await time.advance(1);
		expect(engine.health()).toBe("degraded");
		await engine.stop();
	});

	test("a disabled (stopped) channel never degrades health", async () => {
		const host = await fakeHost({ loop: { enabled: false } });
		const adapter = fakeAdapter("loop");
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		expect(adapter.contexts).toEqual([]);
		expect(engine.status().channels.loop?.state).toBe("stopped");
		// Only `backoff`/`failed` dwell counts (§8.12); a deliberately
		// disabled channel stays health-neutral however long it sits.
		await time.advance(600_000);
		expect(engine.health()).toBe("ok");
		await engine.stop();
	});

	test("degraded only after 300000 ms in backoff", async () => {
		const host = await fakeHost();
		const adapter = fakeAdapter("loop");
		adapter.failEveryStart = true;
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([
			{ extension: "fixture", channel: adapter },
		]));
		// Fresh backoff: not yet degraded (the 300000 ms threshold). The
		// unhealthy clock starts at the FIRST failure (t=0 here) and the
		// mid-window retry failures do not reset it.
		expect(engine.health()).toBe("ok");
		await time.advance(299000);
		expect(engine.health()).toBe("ok");
		await time.advance(1);
		expect(engine.health()).toBe("ok");
		// One ms past the threshold: degraded (the retries that fired
		// inside the window kept failing — the dwell never restarted).
		await time.advance(1000);
		expect(engine.health()).toBe("degraded");
		// The failedRecently dependency (ledger, Task 5): >0 degrades too.
		const withLedger = createEngine(host, {
			timers: fakeTimers(new FakeTime()),
			failedRecently: () => 1,
		});
		expect(withLedger.health()).toBe("degraded");
		await engine.stop();
		await withLedger.stop();
	});

	test("the default failedRecently reads 0 (the ledger lands in Task 5)", async () => {
		const host = await fakeHost();
		const engine: GatewayEngine & EngineInternals = createEngine(host);
		expect(engine.health()).toBe("ok");
		await engine.stop();
	});
});

// ---------------------------------------------------------------------------
// State dir (the Task 1 contract holds under supervision)
// ---------------------------------------------------------------------------

describe("engine state dir under supervision", () => {
	test("start still creates <stateDir>/gateway", async () => {
		const host = await fakeHost();
		const time = new FakeTime();
		const engine = createEngine(host, { timers: fakeTimers(time) });
		await engine.start(engineCtx([]));
		const stats = await stat(
			join(host.stores.paths.state, "gateway"),
		);
		expect(stats.isDirectory()).toBe(true);
		await engine.stop();
	});
});

/** The injectable timer bundle the engine's EngineDeps.timers reads. */
function fakeTimers(time: FakeTime): {
	now(): number;
	random(): number;
	setTimer(fn: () => void, ms: number): () => void;
} {
	return {
		now: () => time.now,
		random: () => time.random,
		setTimer: time.setTimer,
	};
}
