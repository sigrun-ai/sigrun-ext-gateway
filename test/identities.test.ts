/** Core-backed sender identities (Task 13): allowlist precedence, link
 * conflicts, home-only persistence, and legacy-link warnings. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatRef } from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { parseGatewayConfig, type ChannelConfig } from "../src/config.js";
import { IdentityStore } from "../src/state/identities.js";
import type { EngineLog } from "../src/log.js";

const CHAT: ChatRef = { chatId: "100000001", chatType: "dm" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function config(allow: readonly { sender: string; user: string }[] = []): ChannelConfig {
	const parsed = parseGatewayConfig({
		channels: { loop: { dm: "allowlist", allow } },
	}).channels.loop;
	if (parsed === undefined || "failed" in parsed) {
		throw new Error("test setup: loop channel must parse");
	}
	return parsed;
}

async function rig(): Promise<{ host: FakeHost; store: IdentityStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-identities-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice" }, { user: "bob" }],
	});
	return {
		host,
		store: new IdentityStore(host, join(dir, "identities.json")),
		dir,
	};
}

describe("IdentityStore over host.accounts", () => {
	test("an allowlist hit resolves via allow without calling host.accounts", async () => {
		const { host, store } = await rig();
		expect(await store.userFor(config([{ sender: "100000001", user: "alice" }]), "loop", "100000001")).toEqual({
			user: "alice",
			via: "allow",
		});
		expect(host.calls.filter((call) => call.method.startsWith("accounts."))).toEqual([]);
	});

	test("a core link resolves via link and records its provenance", async () => {
		const { host, store } = await rig();
		await store.link("loop", "100000001", "alice", "self", CHAT);
		expect(await store.userFor(config(), "loop", "100000001")).toEqual({
			user: "alice",
			via: "link",
		});
		expect(host.accountLinks()).toEqual([
			expect.objectContaining({
				provider: "chat:loop",
				subject: "100000001",
				user: "alice",
				via: "self",
			}),
		]);
	});

	test("allowlist precedence leaves a disagreeing core link inert", async () => {
		const { host, store } = await rig();
		await store.link("loop", "100000001", "bob", "self", CHAT);
		expect(await store.userFor(config([{ sender: "100000001", user: "alice" }]), "loop", "100000001")).toEqual({
			user: "alice",
			via: "allow",
		});
		expect(host.calls.filter((call) => call.method === "accounts.lookup")).toEqual([]);
	});

	test("a conflicting link is refused without setting a home", async () => {
		const { store } = await rig();
		expect(await store.link("loop", "100000001", "alice", "self", CHAT)).toEqual({ linked: true });
		expect(await store.link("loop", "100000001", "bob", "pairing", CHAT)).toEqual({
			linked: false,
			reason: "conflict",
		});
		expect(store.homesOf("bob")).toEqual([]);
	});

	test("a same-user re-link is a no-op but preserves the first home", async () => {
		const { host, store } = await rig();
		await store.link("loop", "100000001", "alice", "self", CHAT);
		await store.setHome("alice", "loop", { chatId: "200000002", chatType: "dm" });
		expect(await store.link("loop", "100000001", "alice", "pairing", CHAT)).toEqual({ linked: true });
		expect(host.accountLinks()).toHaveLength(1);
		expect(store.homesOf("alice")[0]?.chat.chatId).toBe("200000002");
	});

	test("a failed home write keeps the mirror honest and rethrows", async () => {
		const { store, dir } = await rig();
		const path = join(dir, "identities.json");
		// A directory where the JSON file belongs rejects the real write
		// after core has durably linked the sender. Remove it before the
		// same-user retry so the next durable write can succeed.
		await mkdir(path);
		await expect(store.link("loop", "100000001", "alice", "self", CHAT)).rejects.toThrow();
		expect(store.homesOf("alice")).toEqual([{ channel: "loop", chat: CHAT }]);
		await rm(path, { recursive: true });
		expect(await store.link("loop", "100000001", "alice", "self", CHAT)).toEqual({ linked: true });
		expect(store.homesOf("alice")).toEqual([{ channel: "loop", chat: CHAT }]);
	});

	test("unknown-user errors propagate", async () => {
		const { store } = await rig();
		await expect(store.link("loop", "100000001", "nobody", "self", CHAT)).rejects.toThrow(
			'unknown user "nobody"',
		);
	});

	test("forgetHomes removes homes but leaves core links alone", async () => {
		const { host, store } = await rig();
		await store.link("loop", "100000001", "alice", "self", CHAT);
		await store.forgetHomes("alice");
		expect(store.homesOf("alice")).toEqual([]);
		expect(await store.userFor(config(), "loop", "100000001")).toEqual({
			user: "alice",
			via: "link",
		});
		expect(host.accountLinks()).toHaveLength(1);
	});

	test("fake host rejects an unknown user before a same-user existing link", async () => {
		const { host } = await rig();
		await host.accounts.link("chat:loop", "100000001", "alice", "self");
		await expect(
			host.accounts.link("chat:loop", "100000001", "nobody", "self"),
		).rejects.toThrow('unknown user "nobody"');
	});

	test("a legacy links object warns once and disappears on the next write", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-legacy-identities-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "identities.json");
		await writeFile(path, JSON.stringify({
			links: {
				"loop:100000001": { user: "alice", via: "self" },
				"loop:200000002": { user: "bob", via: "pairing" },
			},
			homes: {},
		}));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }, { user: "bob" }] });
		const warnings: string[] = [];
		const log: EngineLog = {
			info: () => {},
			warn: (message) => { warnings.push(message); },
			error: () => {},
			debug: () => {},
			once: (_key, _level, message) => { warnings.push(message); },
		};
		const store = new IdentityStore(host, path, { log });
		await store.setHome("alice", "loop", CHAT);
		const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(raw.links).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("2");
		expect(warnings[0]).toContain("those senders must pair or self-link again");
	});
});
