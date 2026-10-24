/**
 * The pairing store (spec §8.2): limits (1 pending per sender, 1 new
 * request per sender per 600000 ms, 3 pending per channel), expiry at
 * 3600000 ms, and persistence at `pairing.json`.
 *
 * Tests own their literals: codes are read from the store's return
 * values, never asserted as literal strings.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PairingStore } from "../src/access/pairing.js";
import type { ChatRef } from "@sigrun/sigrun/extension";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const T0 = 1_700_000_000_000;

/** The DM chat the request carries (the approval routes the reply there). */
const dm: ChatRef = { chatId: "100000005", chatType: "dm" };

/** One store over a fresh temp dir, with a mutable pinned clock. */
async function rig(
	clock = T0,
): Promise<{ store: PairingStore; path: string; tick(to: number): void }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-pairing-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pairing.json");
	let now = clock;
	const store = new PairingStore(path, { now: () => now });
	return { store, path, tick: (to) => (now = to) };
}

/** Request as a sender, asserting success and returning the code. */
function ok(
	result: { code: string } | { limited: "sender" | "cooldown" | "channel" },
): string {
	if (!("code" in result)) throw new Error("test setup: request was limited");
	return result.code;
}

describe("PairingStore: request limits", () => {
	test("the first request returns an 8-character code", async () => {
		const { store } = await rig();
		expect(ok(store.request("loop", { id: "100000001", name: "Alice" }, dm, T0))).toHaveLength(8);
	});

	test("a second pending request from one sender is limited: sender", async () => {
		const { store } = await rig();
		ok(store.request("loop", { id: "100000001" }, dm, T0));
		expect(store.request("loop", { id: "100000001" }, dm, T0 + 1)).toEqual({
			limited: "sender",
		});
	});

	test("a new request within 600000 ms of the last is limited: cooldown (even with no pending left)", async () => {
		const { store } = await rig();
		const code = ok(store.request("loop", { id: "100000001" }, dm, T0));
		store.approve(code, T0 + 1);
		expect(store.request("loop", { id: "100000001" }, dm, T0 + 599_999)).toEqual({
			limited: "cooldown",
		});
		expect("code" in store.request("loop", { id: "100000001" }, dm, T0 + 600_000)).toBe(true);
	});

	test("a fourth pending request on one channel is limited: channel (per channel)", async () => {
		const { store } = await rig();
		for (const id of ["100000001", "100000002", "100000003"]) {
			ok(store.request("loop", { id }, dm, T0));
		}
		expect(store.request("loop", { id: "100000004" }, dm, T0 + 1)).toEqual({
			limited: "channel",
		});
		// The channel limit does not bleed across channels.
		expect("code" in store.request("signal", { id: "100000004" }, dm, T0 + 2)).toBe(true);
	});

	test("limits are enforced across a restart (the persisted file)", async () => {
		const { store, path } = await rig();
		ok(store.request("loop", { id: "100000001" }, dm, T0));
		const reopened = new PairingStore(path, { now: () => T0 + 1 });
		expect(reopened.request("loop", { id: "100000001" }, dm, T0 + 1)).toEqual({
			limited: "sender",
		});
	});
});

describe("PairingStore: expiry and lifecycle", () => {
	test("entries expire at 3600000 ms (dropped on read)", async () => {
		const { store, tick } = await rig();
		const code = ok(store.request("loop", { id: "100000001" }, dm, T0));
		expect(store.pending()).toHaveLength(1);
		tick(T0 + 3_599_999);
		expect(store.pending()).toHaveLength(1);
		tick(T0 + 3_600_000);
		expect(store.pending()).toEqual([]);
		expect(store.approve(code)).toBeUndefined();
		// With the row expired, the channel has room again.
		expect("code" in store.request("loop", { id: "100000002" }, dm, T0 + 3_600_000)).toBe(true);
	});

	test("approve returns the request and clears it; a code approves once", async () => {
		const { store } = await rig();
		const code = ok(store.request("loop", { id: "100000001", name: "Alice" }, dm, T0));
		expect(store.pending()).toHaveLength(1);
		const approved = store.approve(code, T0 + 1);
		expect(approved).toMatchObject({
			channel: "loop",
			senderId: "100000001",
			senderName: "Alice",
			createdAt: T0,
		});
		expect(approved?.chat).toEqual(dm);
		expect(store.pending()).toHaveLength(0);
		expect(store.approve(code, T0 + 2)).toBeUndefined();
	});

	test("deny removes the request and returns true; unknown codes false", async () => {
		const { store } = await rig();
		const code = ok(store.request("loop", { id: "100000001" }, dm, T0));
		expect(store.deny(code)).toBe(true);
		expect(store.pending()).toHaveLength(0);
		expect(store.deny(code)).toBe(false);
	});

	test("pending filters by channel", async () => {
		const { store } = await rig();
		ok(store.request("loop", { id: "100000001" }, dm, T0));
		ok(store.request("signal", { id: "100000002" }, dm, T0));
		expect(store.pending("loop")).toHaveLength(1);
		expect(store.pending("loop")[0]).toMatchObject({ channel: "loop" });
		expect(store.pending()).toHaveLength(2);
	});

	test("the file persists pending rows (the restart read)", async () => {
		const { store, path } = await rig();
		ok(store.request("loop", { id: "100000001" }, dm, T0));
		const text = await readFile(path, "utf8");
		expect(JSON.parse(text).pending).toHaveLength(1);
	});
});
