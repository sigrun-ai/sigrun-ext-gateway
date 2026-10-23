/**
 * JsonFile<T> (engine state files): serialized updates, atomic 0600
 * writes, and the loud malformed-file error that names the path (the
 * sigrun stores contract — a corrupt state file is never silently
 * reset).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { JsonFile } from "../src/state/json-file.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function tempFile(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-json-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return join(dir, name);
}

describe("JsonFile", () => {
	test("read on an absent file returns the initial value", async () => {
		const path = await tempFile("state.json");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		expect(await file.read()).toEqual({ count: 0 });
	});

	test("update runs the mutator and persists; read returns the new state", async () => {
		const path = await tempFile("state.json");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		const result = await file.update((draft) => {
			draft.count += 1;
		});
		expect(result).toEqual({ count: 1 });
		expect(await file.read()).toEqual({ count: 1 });
	});

	test("the file is written mode 0600", async () => {
		const path = await tempFile("state.json");
		const file = new JsonFile<{ n: number }>(path, () => ({ n: 7 }));
		await file.update((draft) => {
			draft.n = 8;
		});
		const stats = await stat(path);
		// 0o600 = rw for owner only; state carries identity links.
		expect(stats.mode & 0o777).toBe(0o600);
	});

	test("concurrent updates serialize (never last-write-wins, never interleaved)", async () => {
		const path = await tempFile("state.json");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		await Promise.all(
			Array.from({ length: 50 }, () =>
				file.update((draft) => {
					draft.count += 1;
				}),
			),
		);
		expect((await file.read()).count).toBe(50);
	});

	test("an async mutator is awaited inside the serialization window", async () => {
		const path = await tempFile("state.json");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		await Promise.all(
			Array.from({ length: 10 }, () =>
				file.update(async (draft) => {
					// A mutator that yields mid-flight: serialization must hold
					// the queue across the await, or two of these interleave.
					await new Promise((resolve) => setTimeout(resolve, 1));
					draft.count += 1;
				}),
			),
		);
		expect((await file.read()).count).toBe(10);
	});

	test("a malformed file throws naming the path", async () => {
		const path = await tempFile("state.json");
		await writeFile(path, "{not json", "utf8");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		await expect(file.read()).rejects.toThrow(path);
	});

	test("a malformed file throws naming the path on update too", async () => {
		const path = await tempFile("state.json");
		await writeFile(path, "not json at all", "utf8");
		const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
		await expect(
			file.update((draft) => {
				draft.count += 1;
			}),
		).rejects.toThrow(path);
	});
});
