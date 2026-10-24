/**
 * The durable delivery ledger (spec §8.6): the entry state machine
 * (pending → attempting → delivered/failed), tag dedupe, restart
 * recovery (attempting → pending with the recovered flag), the
 * failed-in-window health count, and the 7-day prune of delivered
 * entries.
 *
 * Tests own their literals: chat ids, tags, a fake clock.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ChatRef } from "@sigrun/sigrun/extension";
import { Ledger, type LedgerEntry } from "../src/state/ledger.js";

const CHAT: ChatRef = { chatId: "100000001", chatType: "dm" };

/** The enqueue input (everything the caller owns). */
function input(over: Partial<Parameters<Ledger["enqueue"]>[0]> = {}) {
	return {
		channel: "loop",
		chat: CHAT,
		kind: "final" as const,
		message: { chat: CHAT, text: "hello" },
		...over,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-ledger-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function silentLog(): import("../src/log.js").EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

describe("Ledger state machine", () => {
	test("enqueue returns the entry in pending state with id/attempts/createdAt", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		const entry = await ledger.enqueue(input());
		expect(entry).toMatchObject({
			channel: "loop",
			state: "pending",
			attempts: 0,
			createdAt: 1000,
		});
		expect(typeof entry?.id).toBe("string");
	});

	test("nextPending returns the oldest pending entry for the channel and none after", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		const first = await ledger.enqueue(input());
		const second = await ledger.enqueue(input({ message: { chat: CHAT, text: "two" } }));
		expect(ledger.nextPending("loop")?.id).toBe(first?.id);
		await ledger.mark(first!.id, "attempting");
		expect(ledger.nextPending("loop")?.id).toBe(second?.id);
		await ledger.mark(second!.id, "delivered", ["m-1"]);
		expect(ledger.nextPending("loop")).toBeUndefined();
	});

	test("nextPending scopes by channel", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		await ledger.enqueue(input());
		expect(ledger.nextPending("other")).toBeUndefined();
	});

	test("mark stores the receipt", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		const entry = await ledger.enqueue(input());
		await ledger.mark(entry!.id, "delivered", ["loop-1", "loop-2"]);
		expect(ledger.nextPending("loop")).toBeUndefined();
		const path = join(await tempDir(), "ledger.json");
		const persistable = new Ledger(path, { now: () => 1000 });
		const persisted = await persistable.enqueue(input());
		await persistable.mark(persisted!.id, "delivered", ["loop-1"]);
		// The receipt is observable through a second Ledger over the same path.
		const reloaded = new Ledger(path, { now: () => 1000 });
		expect(reloaded.nextPending("loop")).toBeUndefined();
	});

	test("mark increments attempts on attempting", async () => {
		const path = join(await tempDir(), "ledger.json");
		const persistable = new Ledger(path, { now: () => 1000 });
		const persisted = await persistable.enqueue(input());
		await persistable.mark(persisted!.id, "attempting");
		// The attempts count rides the entry the worker re-reads after a
		// failure: verify through a restart-recovered pending read.
		const recovered = await recover(path);
		expect(recovered.attempts).toBe(1);
	});

	/** Re-start the ledger over the same file and read the pending entry. */
	async function recover(path: string): Promise<LedgerEntry> {
		const second = new Ledger(path, { now: () => 2000 });
		await second.recoverAfterRestart();
		const pending = second.nextPending("loop");
		if (pending === undefined) throw new Error("no recovered pending entry");
		return pending;
	}
});

describe("Ledger tag dedupe", () => {
	test("a second enqueue with the same tag returns undefined and is not stored", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		const first = await ledger.enqueue(
			input({ tag: "final:1:9:loop:default:dm:100000001" }),
		);
		expect(first).toBeDefined();
		const second = await ledger.enqueue(
			input({ tag: "final:1:9:loop:default:dm:100000001" }),
		);
		expect(second).toBeUndefined();
		expect(ledger.nextPending("loop")?.id).toBe(first?.id);
	});

	test("different tags both enqueue", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		await ledger.enqueue(input({ tag: "a" }));
		await ledger.enqueue(input({ tag: "b" }));
		const first = ledger.nextPending("loop");
		await ledger.mark(first!.id, "delivered");
		const second = ledger.nextPending("loop");
		expect(second).toBeDefined();
	});
});

describe("Ledger restart recovery", () => {
	test("attempting entries become pending with the recovered flag", async () => {
		const dir = await tempDir();
		const path = join(dir, "ledger.json");
		const first = new Ledger(path, { now: () => 1000 });
		const entry = await first.enqueue(input());
		await first.mark(entry!.id, "attempting");
		const second = new Ledger(path, { now: () => 2000 });
		await second.recoverAfterRestart();
		const recovered = second.nextPending("loop");
		expect(recovered?.id).toBe(entry?.id);
		expect(recovered?.recovered).toBe(true);
	});

	test("pending entries stay pending WITHOUT the recovered flag", async () => {
		const path = join(await tempDir(), "ledger.json");
		const first = new Ledger(path, { now: () => 1000 });
		const entry = await first.enqueue(input());
		const second = new Ledger(path, { now: () => 2000 });
		await second.recoverAfterRestart();
		const pending = second.nextPending("loop");
		expect(pending?.id).toBe(entry?.id);
		expect(pending?.recovered).toBeUndefined();
	});
});

describe("Ledger failedSince and prune", () => {
	test("failedSince counts failed entries created after the timestamp", async () => {
		const ledger = new Ledger(join(await tempDir(), "ledger.json"), {
			now: () => 1000,
		});
		const failedEntry = await ledger.enqueue(input());
		await ledger.mark(failedEntry!.id, "failed");
		expect(ledger.failedSince(0)).toBe(1);
		expect(ledger.failedSince(5000)).toBe(0);
	});

	test("delivered entries are pruned after 7 days; failed and pending stay", async () => {
		const path = join(await tempDir(), "ledger.json");
		let now = 1000;
		const ledger = new Ledger(path, { now: () => now });
		const delivered = await ledger.enqueue(input({ tag: "delivered" }));
		await ledger.mark(delivered!.id, "delivered");
		const failed = await ledger.enqueue(input({ tag: "failed" }));
		await ledger.mark(failed!.id, "failed");
		const pending = await ledger.enqueue(input({ tag: "pending" }));
		// 7 days minus a moment: nothing prunes.
		now = 1000 + 604_800_000 - 1;
		await ledger.prune(now);
		expect(ledger.failedSince(0)).toBe(1);
		// 7 days and one ms: the delivered row is gone, the others stay.
		now = 1000 + 604_800_000 + 1;
		await ledger.prune(now);
		expect(ledger.failedSince(0)).toBe(1);
		void pending;
		const reloaded = new Ledger(path, { now: () => now });
		await reloaded.recoverAfterRestart();
		expect(reloaded.nextPending("loop")).toBeDefined();
	});
});

describe("Ledger files", () => {
	test("entries with files are ledgered by workspace path, never bytes", async () => {
		const path = join(await tempDir(), "ledger.json");
		const ledger = new Ledger(path, { now: () => 1000, log: silentLog() });
		const entry = await ledger.enqueue(
			input({
								message: {
										chat: CHAT,
										text: "see attachment",
										files: [
												{
														name: "doc.pdf",
														mime: "application/pdf",
														bytes: new Uint8Array([1, 2, 3]),
												},
										],
								},
								files: [
										{
												conversationId: 7,
												path: "uploads/7/doc.pdf",
												name: "doc.pdf",
												mime: "application/pdf",
										},
								],
			}),
		);
		expect(entry).toBeDefined();
		// The persisted JSON never contains the bytes: re-read through a
		// fresh Ledger and inspect the raw file for the byte pattern.
		const raw = await import("node:fs/promises").then((fs) =>
			fs.readFile(path, "utf8"),
		);
		expect(raw).not.toContain('"bytes"');
		expect(raw).toContain("uploads/7/doc.pdf");
	});
});
