/**
 * The loader-contract factory (spec §8.0): the default export is an
 * arity-1 factory (it DECLARES the host parameter — the host rule)
 * returning `{ extension, gateway }` with the declared name "gateway",
 * and the engine skeleton's `start` creates the state directory.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import createGateway from "../src/index.js";
import { createEngine } from "../src/engine.js";
import type { EngineLog } from "../src/log.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function fakeHost(): Promise<FakeHost> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-factory-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir });
	// The factory test owns the dir; the fake's close() would be a no-op
	// (caller-supplied storesDir), so the cleanup above is the whole story.
	return host;
}

describe("createGateway (the factory)", () => {
	test("quarantines a core without host.accounts", async () => {
		const host = await fakeHost();
		const legacy = Object.fromEntries(
			Object.entries(host).filter(([key]) => key !== "accounts"),
		) as unknown as Parameters<typeof createGateway>[0];
		expect(() => createGateway(legacy)).toThrow(
			"gateway requires sigrun core with host.accounts (multi-user M3a)",
		);
	});

	test("returns extension.name === \"gateway\" and a gateway with the four functions", async () => {
		const host = await fakeHost();
		const result = await createGateway(host);
		expect(result.extension?.name).toBe("gateway");
		expect(result.extension?.tools?.map((tool) => tool.name)).toEqual([
			"send_message",
			"list_chats",
		]);
		expect(result.extension?.sections?.map((section) => section.key)).toEqual([
			"gateway-channel",
		]);
		expect(typeof result.gateway?.start).toBe("function");
		expect(typeof result.gateway?.stopIntake).toBe("function");
		expect(typeof result.gateway?.stop).toBe("function");
		expect(typeof result.gateway?.health).toBe("function");
	});

	test("the factory declares the host parameter (arity 1 — the host rule)", () => {
		// A length-0 factory with a defaulted first parameter would consume
		// the host as that default; the loader only passes the host when
		// factory.length > 0.
		expect(createGateway.length).toBe(1);
	});

	test("engine construction warns about legacy link count", async () => {
		const host = await fakeHost();
		const gatewayDir = join(host.stores.paths.state, "gateway");
		await mkdir(gatewayDir, { recursive: true });
		await writeFile(join(gatewayDir, "identities.json"), JSON.stringify({
			links: {
				"loop:100000001": { user: "alice", via: "self" },
				"loop:200000002": { user: "bob", via: "pairing" },
			},
			homes: {},
		}));
		const warnings: string[] = [];
		const log: EngineLog = {
			info: () => {},
			warn: (message) => { warnings.push(message); },
			error: () => {},
			debug: () => {},
			once: () => {},
		};
		createEngine(host, { log });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("2 legacy links");
	});

	test("start creates the state dir and records the channels; health is ok", async () => {
		const host = await fakeHost();
		const result = await createGateway(host);
		const engine = result.gateway;
		if (engine === undefined) throw new Error("no gateway on the result");
		await engine.start({
			channels: [],
			signal: new AbortController().signal,
		});
		const stateDir = host.stores.paths.state;
		const stats = await stat(stateDir);
		expect(stats.isDirectory()).toBe(true);
		expect(engine.health()).toBe("ok");
		await engine.stopIntake();
		await engine.stop();
	});

	test("start records the channel ids it was handed", async () => {
		const host = await fakeHost();
		// Enablement is read from settings at start (Task 2): the channel
		// must appear in `channels` (absent = disabled, spec §8.1).
		await host.stores.settings.set({ channels: { loop: {} } });
		const result = await createGateway(host);
		const engine = result.gateway;
		if (engine === undefined) throw new Error("no gateway on the result");
		const seen: string[] = [];
		await engine.start({
			channels: [
				{
					extension: "fixture-loopback-channel",
					channel: {
						id: "loop",
						label: "Loop",
						capabilities: {
							chatTypes: ["dm"],
							maxMessageLength: 100,
							format: "markdown",
						},
						configured: () => ({ status: "ready" }),
						start: async () => {
							seen.push("loop");
						},
						send: async () => ({ messageIds: [] }),
					},
				},
			],
			signal: new AbortController().signal,
		});
		expect(seen).toEqual(["loop"]);
		await engine.stop();
	});

	test("stop before start resolves (the lazy-start shutdown edge)", async () => {
		const host = await fakeHost();
		const result = await createGateway(host);
		const engine = result.gateway;
		if (engine === undefined) throw new Error("no gateway on the result");
		await engine.stopIntake();
		await engine.stop();
		expect(engine.health()).toBe("ok");
	});

	test("start skips a mis-shaped channel id loudly", async () => {
		const host = await fakeHost();
		await host.stores.settings.set({ channels: { "Loop Bad": {} } });
		const warnings: string[] = [];
		const log: EngineLog = {
			info: () => {},
			warn: (message) => { warnings.push(message); },
			error: () => {},
			debug: () => {},
			once: () => {},
		};
		const engine = createEngine(host, { log });
		let starts = 0;
		await engine.start({
			channels: [{
				extension: "fixture",
				channel: {
					id: "Loop Bad",
					label: "Bad",
					capabilities: { chatTypes: ["dm"], maxMessageLength: 100, format: "markdown" },
					configured: () => ({ status: "ready" }),
					start: async () => { starts++; },
					send: async () => ({ messageIds: [] }),
				},
			}],
			signal: new AbortController().signal,
		});
		expect(starts).toBe(0);
		expect(warnings.some((message) => message.includes('channel "Loop Bad" has an invalid id'))).toBe(true);
		expect(engine.status().channels["Loop Bad"]?.state).toBe("failed");
		await engine.stop();
	});

	test("readConfig reads through the fake host's scoped settings store", async () => {
		// The engine's config is live (parsed per read): the factory result
		// does not snapshot it. This pins the seam through the fake host.
		const host = await fakeHost();
		await host.stores.settings.set({ media: { maxBytes: 4 } });
		const result = await createGateway(host);
		void result;
		const { readConfig } = await import("../src/config.js");
		const config = await readConfig(host);
		expect(config.media.maxBytes).toBe(4);
	});
});
