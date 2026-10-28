/**
 * Replay-safe prompt retention (release-readiness spec 4 §§2–4): the
 * persisted file is versioned; settled rows expire seven days after
 * settlement while compact tombstones (identity + timestamp + outcome)
 * persist permanently so delayed receipts never resurrect a prompt.
 * Time is injected at construction; no timers.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { bindingKey } from "../src/state/bindings.js";
import { PromptStore, PROMPT_RETENTION_MS } from "../src/interactions/prompts.js";
import type { EngineLog } from "../src/log.js";

const CHAT = { chatId: "100000001", chatType: "dm" } as const;
const KEY = bindingKey("loop", CHAT);
const REF = { chat: CHAT, messageId: "loop-1" } as const;
const PLAN = { kind: "webui" } as const;
const T0 = 1_760_000_000_000;
const WEEK = PROMPT_RETENTION_MS;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Rig {
	readonly store: PromptStore;
	readonly path: string;
	readonly clock: { now: number };
	readonly warnings: string[];
}

async function rig(at = T0, seed?: unknown): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-prompts-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "prompts.json");
	if (seed !== undefined) await writeFile(path, JSON.stringify(seed));
	const clock = { now: at };
	const warnings: string[] = [];
	const log: EngineLog = {
		info: () => {},
		warn: (message) => { warnings.push(message); },
		error: () => {},
		debug: () => {},
		once: () => {},
	};
	const store = new PromptStore(path, { now: () => clock.now, log });
	return { store, path, clock, warnings };
}

function v1(settled: readonly string[] = []): { prompts: unknown[]; settled: string[] } {
	return {
		prompts: [{
			conversationId: 7, callId: "call-1", key: KEY, ref: REF, plan: PLAN,
		}],
		settled: [...settled],
	};
}

describe("schema migration (spec §2)", () => {
	test("an unversioned v1 file preserves rows and stamps the settled cohort at migration time", async () => {
		const r = await rig(T0, v1([`7:call-1:${KEY}`, "9:call-old:user:alice"]));
		// The settled identity stays tombstoned: not answerable.
		expect(r.store.pendingInChat(KEY)).toEqual([]);
		expect(r.store.refsOf(7, "call-1")).toEqual([REF]);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.version).toBe(2);
		expect(persisted.settled[`7:call-1:${KEY}`]).toEqual({ at: T0, outcome: "answered" });
		expect(persisted.settled["9:call-old:user:alice"]).toEqual({ at: T0, outcome: "answered" });
	});

	test("the migrated cohort expires as ONE batch at the first boundary seven days later", async () => {
		const r = await rig(T0, v1([`7:call-1:${KEY}`, "9:call-old:user:alice"]));
		// A write inside the window does NOT re-stamp the cohort.
		r.clock.now = T0 + WEEK - 1000;
		await r.store.record(11, "call-other", KEY, REF, PLAN);
		let persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled[`7:call-1:${KEY}`].at).toBe(T0);
		expect(persisted.settled["9:call-old:user:alice"].at).toBe(T0);
		// At the boundary BOTH cohort rows prune together.
		r.clock.now = T0 + WEEK;
		await r.store.record(12, "call-next", KEY, REF, PLAN);
		persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.prompts.filter((row: { callId: string }) => row.callId === "call-1")).toHaveLength(0);
		expect(persisted.settled[`7:call-1:${KEY}`].at).toBe(T0);
		expect(persisted.settled["9:call-old:user:alice"].at).toBe(T0);
		// The unrelated live row is untouched.
		expect(r.store.has(12, "call-next", KEY)).toBe(true);
	});

	test("a fresh store starts at version 2 with no rows", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.version).toBe(2);
		expect(persisted.prompts).toHaveLength(1);
		expect(persisted.settled).toEqual({});
	});
});

describe("the retention boundary (spec §§3–4)", () => {
	test("a pending row older than seven days survives and stays answerable", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, { kind: "choice", field: "decision" } as never);
		r.clock.now = T0 + 30 * 24 * 3_600_000;
		// Init-prune of a NEW store over the same file keeps the row.
		const reopened = await rig(r.clock.now, JSON.parse(await readFile(r.path, "utf8")));
		expect(reopened.store.pendingInChat(KEY)).toHaveLength(1);
		// Write-prune keeps it too.
		await reopened.store.record(8, "call-2", KEY, REF, PLAN);
		expect(reopened.store.pendingInChat(KEY).map((prompt) => prompt.callId)).toContain("call-1");
	});

	test("a settled row younger than seven days survives for edits", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + WEEK - 1;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([REF]);
		expect(r.store.pendingInChat(KEY).map((prompt) => prompt.callId)).not.toContain("call-1");
	});

	test("a settled row older than seven days is pruned; its tombstone remains", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + WEEK + 1;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled[`7:call-1:${KEY}`]).toEqual({ at: T0, outcome: "answered: allow" });
	});

	test("the predicate expires at exactly settledAt + RETENTION_MS <= now (write-prune)", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1");
		// One ms BEFORE the boundary the row survives a write.
		r.clock.now = T0 + WEEK - 1;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([REF]);
		// Exactly AT the boundary the next write prunes it.
		r.clock.now = T0 + WEEK;
		await r.store.record(9, "call-3", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
	});

	test("init-pruning expires at exactly the boundary too", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1");
		const seed = JSON.parse(await readFile(r.path, "utf8"));
		const atBoundary = await rig(T0 + WEEK, seed);
		expect(atBoundary.store.refsOf(7, "call-1")).toEqual([]);
		// The tombstone survives init-pruning and persists on the next write.
		await atBoundary.store.record(8, "call-2", KEY, REF, PLAN);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled[`7:call-1:${KEY}`].at).toBe(T0);
	});

	test("repeated settle keeps the ORIGINAL settlement timestamp", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + 1000;
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + 2000;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled[`7:call-1:${KEY}`].at).toBe(T0);
	});

	test("repeated settle/prune/write cycles are idempotent", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + WEEK + 5;
		for (let index = 0; index < 3; index++) {
			await r.store.settle(7, "call-1", "answered: allow");
			await r.store.record(8, "call-2", KEY, REF, PLAN);
		}
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.prompts.filter((row: { callId: string }) => row.callId === "call-1")).toHaveLength(0);
		expect(persisted.prompts.filter((row: { callId: string }) => row.callId === "call-2")).toHaveLength(1);
		expect(persisted.settled[`7:call-1:${KEY}`]).toEqual({ at: T0, outcome: "answered: allow" });
	});

	test("one conversation's pruning does not affect another's prompts", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1");
		await r.store.record(9, "call-9", KEY, REF, PLAN);
		r.clock.now = T0 + WEEK + 1;
		await r.store.record(10, "call-10", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
		expect(r.store.refsOf(9, "call-9")).toEqual([REF]);
		expect(r.store.has(10, "call-10", KEY)).toBe(true);
	});
});

describe("delayed receipts around pruning (spec §3)", () => {
	test("BEFORE pruning, a real receipt still installs refs and exposes the outcome for the self-heal edit", async () => {
		const r = await rig();
		await r.store.markEnqueued(7, "call-1", KEY, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + WEEK - 1000;
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, ["loop-42"]);
		expect(r.store.refsOf(7, "call-1")).toEqual([{ chat: CHAT, messageId: "loop-42" }]);
		expect(r.store.settledOutcome(7, "call-1", KEY)).toBe("answered: allow");
		expect(r.store.pendingInChat(KEY)).toEqual([]);
	});

	test("AFTER pruning, BOTH empty and real delayed receipts recreate nothing", async () => {
		const r = await rig();
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		await r.store.settle(7, "call-1", "answered: allow");
		r.clock.now = T0 + WEEK + 1;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
		// An empty receipt (retry artifact) is a no-op.
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, []);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
		// A REAL receipt is a no-op too: no row, no answerable prompt.
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, ["loop-late"]);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
		expect(r.store.pendingInChat(KEY).map((prompt) => prompt.callId)).not.toContain("call-1");
		// A direct record() cannot resurrect the pruned row either.
		await r.store.record(7, "call-1", KEY, REF, PLAN);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
		// The tombstone still carries the outcome.
		expect(r.store.settledOutcome(7, "call-1", KEY)).toBe("answered: allow");
	});

	test("a settled empty-ref row still tombstones after pruning", async () => {
		const r = await rig();
		await r.store.markEnqueued(7, "call-1", KEY, PLAN);
		await r.store.settle(7, "call-1", "cancelled");
		r.clock.now = T0 + WEEK + 1;
		await r.store.record(8, "call-2", KEY, REF, PLAN);
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, ["loop-late"]);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
		expect(r.store.settledOutcome(7, "call-1", KEY)).toBe("cancelled");
	});

	test("settlement with literally no rows blocks a later row for that call", async () => {
		const r = await rig();
		await r.store.settle(7, "call-1", "answered: allow");
		await r.store.markEnqueued(7, "call-1", KEY, PLAN);
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, ["loop-late"]);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
		expect(r.store.pendingInChat(KEY)).toEqual([]);
		expect(r.store.settledOutcome(7, "call-1", KEY)).toBe("answered: allow");
		r.clock.now = T0 + WEEK + 1;
		await r.store.settle(7, "call-1", "answered: allow");
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled["7:call-1:"]).toEqual({ at: T0, outcome: "answered: allow" });
	});
});

describe("startup health and malformed entries (spec §2)", () => {
	test("startup with an already-pruned file is healthy", async () => {
		const seed = {
			version: 2,
			prompts: [],
			settled: { [`7:call-1:${KEY}`]: { at: T0, outcome: "answered: allow" } },
		};
		const r = await rig(T0 + 365 * 24 * 3_600_000, seed);
		expect(r.store.refsOf(7, "call-1")).toEqual([]);
		expect(r.store.pendingInChat(KEY)).toEqual([]);
		expect(r.store.settledOutcome(7, "call-1", KEY)).toBe("answered: allow");
		await r.store.recordReceipt(7, "call-1", KEY, CHAT, ["loop-late"]);
		expect(r.store.has(7, "call-1", KEY)).toBe(false);
	});

	test("a malformed tombstone is dropped with a log; valid rows survive", async () => {
		const seed = {
			version: 2,
			prompts: [
				{ conversationId: 7, callId: "call-1", key: KEY, ref: REF, plan: PLAN },
				{ conversationId: 9, callId: "call-9", key: KEY, ref: REF, plan: PLAN },
			],
			settled: {
				[`7:call-1:${KEY}`]: { at: "not-a-number", outcome: "answered" },
				"no-colons-at-all": { at: T0, outcome: "answered" },
				[`9:call-9:${KEY}`]: { at: T0, outcome: "answered" },
			},
		};
		const r = await rig(T0, seed);
		// The malformed timestamp tombstone is gone: its row is live again.
		expect(r.store.pendingInChat(KEY).map((prompt) => prompt.callId)).toContain("call-1");
		// The valid tombstone for the other conversation survives.
		expect(r.store.settledOutcome(9, "call-9", KEY)).toBe("answered");
		expect(r.store.pendingInChat(KEY).map((prompt) => prompt.callId)).not.toContain("call-9");
		expect(r.warnings.length).toBeGreaterThan(0);
		// The next write persists the repaired shape.
		await r.store.record(10, "call-10", KEY, REF, PLAN);
		const persisted = JSON.parse(await readFile(r.path, "utf8"));
		expect(persisted.settled[`7:call-1:${KEY}`]).toBeUndefined();
		expect(persisted.settled["no-colons-at-all"]).toBeUndefined();
		expect(persisted.settled[`9:call-9:${KEY}`].at).toBe(T0);
		expect(persisted.prompts).toHaveLength(3);
	});

	test("a wholly malformed JSON file stays fail-loud", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-prompts-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "prompts.json");
		await writeFile(path, "{not json");
		expect(() => new PromptStore(path)).toThrow(/malformed JSON/);
	});
});
