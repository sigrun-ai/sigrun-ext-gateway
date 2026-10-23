/**
 * hashId + createLog (spec §8.0/§8.12): the id format the plan pins
 * (sha256's first 8 hex chars) and the per-key `once` dedupe — one
 * delivery per key per level, never one per event.
 */

import { describe, expect, test, vi } from "vitest";
import { createLog, hashId } from "../src/log.js";

describe("hashId", () => {
	test("returns 8 lowercase hex chars", () => {
		expect(hashId("100000001")).toMatch(/^[0-9a-f]{8}$/);
	});

	test("stable for the same input (correlation without raw ids)", () => {
		expect(hashId("sender-9001")).toBe(hashId("sender-9001"));
	});

	test("different inputs hash differently", () => {
		expect(hashId("sender-9001")).not.toBe(hashId("sender-9002"));
	});
});

describe("createLog once", () => {
	test("info-level repeated calls fire ONE console.info per key", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const log = createLog("once-test");
			for (let i = 0; i < 3; i++) {
				log.once("dm-drop", "info", "unknown dm dropped");
			}
			const lines = info.mock.calls.map((call) => String(call[0]));
			expect(lines).toEqual(["gateway: once-test unknown dm dropped"]);
		} finally {
			info.mockRestore();
		}
	});

	test("different keys each fire once", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const log = createLog("once-multi");
			log.once("a", "info", "first");
			log.once("b", "info", "second");
			log.once("a", "info", "first again — must not emit");
			expect(info.mock.calls.map((call) => String(call[0]))).toEqual([
				"gateway: once-multi first",
				"gateway: once-multi second",
			]);
		} finally {
			info.mockRestore();
		}
	});

	test("the same key at warn level fires the warn channel (level is per key)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const log = createLog("once-warn");
			log.once("skew", "warn", "config skew");
			log.once("skew", "warn", "config skew again — must not emit");
			expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
				"gateway: once-warn config skew",
			]);
			expect(info).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			info.mockRestore();
		}
	});

	test("scopes separate their once keys (same key, two loggers)", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			// The dedupe key carries the scope prefix, so per-channel loggers
			// with a shared logical key each fire their own line.
			const a = createLog("channel:loop");
			const b = createLog("channel:other");
			a.once("dm-drop", "info", "loop drop");
			b.once("dm-drop", "info", "other drop");
			expect(info.mock.calls.map((call) => String(call[0]))).toEqual([
				"gateway: channel:loop loop drop",
				"gateway: channel:other other drop",
			]);
		} finally {
			info.mockRestore();
		}
	});
});
