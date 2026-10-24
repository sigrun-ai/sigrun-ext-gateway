/**
 * BindingStore + SeenSet + IdentityStore (Task 3, spec §8.2/§8.3): the
 * binding-key shapes, the seen set's in-flight/committed semantics (the
 * pipeline's Review Focus 1), and the identity allow-vs-link resolution.
 *
 * Tests own their literals: alice/bob, synthetic sender ids
 * ("100000001"), no real tokens.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ChatRef } from "@sigrun/sigrun/extension";
import { parseGatewayConfig } from "../src/config.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";
import { SeenSet } from "../src/state/seen.js";
import { IdentityStore } from "../src/state/identities.js";

const dm: ChatRef = { chatId: "100000001", chatType: "dm" };
const group: ChatRef = { chatId: "-100000000002", chatType: "group" };
const thread: ChatRef = {
	chatId: "-100000000002",
	chatType: "thread",
	threadId: "7",
};

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "sigrun-gw-bindings-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("bindingKey", () => {
	test("dm key: channel:default:dm:chatId", () => {
		expect(bindingKey("loop", dm)).toBe("loop:default:dm:100000001");
	});

	test("group key: channel:default:group:chatId", () => {
		expect(bindingKey("loop", group)).toBe(
			"loop:default:group:-100000000002",
		);
	});

	test("thread key carries the thread id segment", () => {
		expect(bindingKey("loop", thread)).toBe(
			"loop:default:thread:-100000000002:7",
		);
	});
});

describe("BindingStore", () => {
	const store = () => new BindingStore(join(dir, "bindings.json"));

	test("get on an absent key reads undefined", async () => {
		const s = store();
		expect(s.get("loop:default:dm:absent")).toBeUndefined();
	});

	test("bind then get returns the binding; unbind clears it", async () => {
		const s = store();
		await s.bind("loop:default:dm:100000001", 42, dm);
		expect(s.get("loop:default:dm:100000001")).toEqual({
			conversationId: 42,
			chat: dm,
			boundAt: expect.any(Number),
			previous: [],
		});
		await s.unbind("loop:default:dm:100000001");
		expect(s.get("loop:default:dm:100000001")).toBeUndefined();
	});

	test("rebind records the previous conversation id in `previous`", async () => {
		const s = store();
		await s.bind("loop:default:dm:100000001", 42, dm);
		await s.bind("loop:default:dm:100000001", 43, dm);
		const binding = s.get("loop:default:dm:100000001");
		expect(binding?.conversationId).toBe(43);
		expect(binding?.previous).toEqual([42]);
	});

	test("keysOf returns every live key of a conversation", async () => {
		const s = store();
		await s.bind("loop:default:dm:100000001", 7, dm);
		await s.bind("loop:default:group:-100000000002", 7, group);
		await s.bind("loop:default:dm:999", 8, { chatId: "999", chatType: "dm" });
		expect(s.keysOf(7)).toEqual([
			"loop:default:dm:100000001",
			"loop:default:group:-100000000002",
		]);
	});

	test("dead bindings read `dead: true`; clearDead restores them", async () => {
		const s = store();
		await s.bind("loop:default:dm:100000001", 42, dm);
		await s.markDead("loop:default:dm:100000001");
		expect(s.get("loop:default:dm:100000001")?.dead).toBe(true);
		// A dead binding still keys its conversation (delivery skips dead
		// rows; rebinding reuses the key).
		expect(s.keysOf(42)).toContain("loop:default:dm:100000001");
		await s.clearDead("loop:default:dm:100000001");
		expect(s.get("loop:default:dm:100000001")?.dead).toBeUndefined();
	});

	test("state persists across instances over the same file", async () => {
		const path = join(dir, "bindings-persist.json");
		const first = new BindingStore(path);
		await first.bind("loop:default:dm:100000001", 42, dm);
		const second = new BindingStore(path);
		expect(second.get("loop:default:dm:100000001")?.conversationId).toBe(42);
	});
});

describe("SeenSet", () => {
	const path = () => join(dir, "seen.json");

	test("claim returns true for a fresh id", () => {
		const s = new SeenSet(path());
		expect(s.claim("loop:default:dm:100000001:m1", 0)).toBe(true);
	});

	test("claim false while the id is IN FLIGHT (Review Focus 1)", () => {
		const s = new SeenSet(path());
		expect(s.claim("id-inflight", 0)).toBe(true);
		expect(s.claim("id-inflight", 1)).toBe(false);
	});

	test("release puts a failed id back to claimable", () => {
		const s = new SeenSet(path());
		expect(s.claim("id-failed", 0)).toBe(true);
		s.release("id-failed");
		expect(s.claim("id-failed", 1)).toBe(true);
	});

	test("claim false for a committed id inside 24 h; true again after", async () => {
		const s = new SeenSet(path());
		expect(s.claim("id-committed", 0)).toBe(true);
		await s.commit("id-committed", 0);
		expect(s.claim("id-committed", 1_000)).toBe(false);
		expect(s.claim("id-committed", 86_400_000)).toBe(false);
		expect(s.claim("id-committed", 86_400_001)).toBe(true);
	});

	test("entries older than 24 h are dropped on write", async () => {
		const p = path();
		const s = new SeenSet(p);
		expect(s.claim("old-id", 0)).toBe(true);
		await s.commit("old-id", 0);
		expect(s.claim("new-id", 86_400_001)).toBe(true);
		await s.commit("new-id", 86_400_001);
		const stored = JSON.parse(await readFile(p, "utf8")) as Record<
			string,
			number
		>;
		expect(stored["old-id"]).toBeUndefined();
		expect(stored["new-id"]).toBe(86_400_001);
	});

	test("committed ids persist across instances", async () => {
		const p = path();
		const first = new SeenSet(p);
		expect(first.claim("persist-id", 0)).toBe(true);
		await first.commit("persist-id", 0);
		const second = new SeenSet(p);
		expect(second.claim("persist-id", 1)).toBe(false);
	});
});

describe("IdentityStore", () => {
	// Each test gets its OWN identities file: the first-link behavior is
	// order-sensitive (a shared file would carry an earlier test's
	// link/home across tests).
	let counter = 0;
	const store = () =>
		new IdentityStore(join(dir, `identities-${counter++}.json`));
	const channelConfig = parseGatewayConfig({
		channels: {
			loop: {
				dm: "allowlist",
				allow: [{ sender: "100000001", user: "alice" }],
			},
		},
	}).channels;
	const loopChannel = channelConfig.loop;
	if (loopChannel === undefined || "failed" in loopChannel) {
		throw new Error("test setup: loop channel must parse");
	}
	const loop = loopChannel;

	test("userFor: an allowlisted sender resolves via allow", () => {
		const s = store();
		expect(s.userFor(loop, "loop", "100000001")).toEqual({
			user: "alice",
			via: "allow",
		});
	});

	test("userFor: an unknown sender resolves undefined", () => {
		const s = store();
		expect(s.userFor(loop, "loop", "999")).toBeUndefined();
	});

	test("userFor: a linked sender resolves via link", async () => {
		const s = store();
		await s.link("loop", "999", "bob", "pairing", {
			chatId: "999",
			chatType: "dm",
		});
		expect(s.userFor(loop, "loop", "999")).toEqual({
			user: "bob",
			via: "link",
		});
	});

	test("the allowlist wins over a conflicting link", async () => {
		const s = store();
		await s.link("loop", "100000001", "bob", "pairing", {
			chatId: "100000001",
			chatType: "dm",
		});
		// The allowlist pins alice; the bob link stays stored but never wins.
		expect(s.userFor(loop, "loop", "100000001")).toEqual({
			user: "alice",
			via: "allow",
		});
	});

	test("the first link sets the home chat; setHome moves it", async () => {
		const s = store();
		const first: ChatRef = { chatId: "9001", chatType: "dm" };
		const second: ChatRef = { chatId: "9002", chatType: "dm" };
		await s.link("loop", "9001", "bob", "pairing", first);
		expect(s.homesOf("bob")).toEqual([{ channel: "loop", chat: first }]);
		await s.setHome("bob", "loop", second);
		expect(s.homesOf("bob")).toEqual([{ channel: "loop", chat: second }]);
	});

	test("unlinkUser removes every link and home of the user", async () => {
		const s = store();
		await s.link("loop", "9001", "bob", "pairing", {
			chatId: "9001",
			chatType: "dm",
		});
		await s.link("loop", "9002", "bob", "self", {
			chatId: "9002",
			chatType: "dm",
		});
		await s.unlinkUser("bob");
		expect(s.userFor(loop, "loop", "9001")).toBeUndefined();
		expect(s.userFor(loop, "loop", "9002")).toBeUndefined();
		expect(s.homesOf("bob")).toEqual([]);
	});

	test("links persist across instances", async () => {
		const p = join(dir, "identities-persist.json");
		const first = new IdentityStore(p);
		await first.link("loop", "9001", "bob", "pairing", {
			chatId: "9001",
			chatType: "dm",
		});
		const second = new IdentityStore(p);
		expect(second.userFor(loop, "loop", "9001")).toEqual({
			user: "bob",
			via: "link",
		});
	});
});
