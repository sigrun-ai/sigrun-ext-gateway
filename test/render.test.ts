/**
 * renderChunks (spec §8.6's three-step order): split at
 * `maxMessageLength`, format per `capabilities.format` (markdown as-is,
 * native through the formatter, plain through the stripper), and a
 * formatted chunk that still exceeds the limit gets hard-split.
 *
 * Tests own their literals; limits pinned at 200 per the loopback table.
 */

import { describe, expect, test } from "vitest";
import type { ChannelCapabilities } from "@sigrun/sigrun/extension";
import { renderChunks } from "../src/outbound/render.js";

function caps(over: Partial<ChannelCapabilities>): ChannelCapabilities {
	return {
		chatTypes: ["dm"],
		maxMessageLength: 200,
		format: "markdown",
		...over,
	};
}

describe("renderChunks", () => {
	test("markdown format passes chunks through as-is", () => {
		const text = "one\n\ntwo";
		// Short enough to stay one chunk.
		expect(renderChunks("one two", caps({ format: "markdown" }))).toEqual([
			"one two",
		]);
		// Over the limit: the split applies (paragraph boundaries first).
		expect(renderChunks(text, caps({ format: "markdown" }))).toEqual([
			"one",
			"two",
		]);
	});

	test("plain format strips markdown", () => {
		const text = "# Hi\n\n**bold** and [link](https://example.invalid)";
		const chunks = renderChunks(text, caps({ format: "plain" }));
		expect(chunks.join("\n\n")).toBe(
			"Hi\n\nbold and link (https://example.invalid)",
		);
		expect(chunks).toHaveLength(2);
	});

	test("native format runs the adapter formatter", () => {
		const text = "*hello*";
		const formatted = renderChunks(text, caps({ format: "native" }), (md) =>
			md.toUpperCase(),
		);
		expect(formatted).toEqual(["*HELLO*"]);
	});

	test("a native formatter that DOUBLES length gets hard-split under the limit", () => {
		const text = "x".repeat(120);
		const chunks = renderChunks(
			text,
			caps({ format: "native" }),
			(md) => md + md,
		);
		// 120 chars doubles to 240 > 200: hard split.
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.length).toBeLessThanOrEqual(200);
		expect(chunks[1]?.length).toBeLessThanOrEqual(200);
		expect(chunks.join("")).toBe(text + text);
	});

	test("splitting applies before formatting (markdown split at maxMessageLength)", () => {
		const text = `${"a".repeat(150)}\n\n${"b".repeat(150)}`;
		const chunks = renderChunks(text, caps({ format: "markdown" }));
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe("a".repeat(150));
		expect(chunks[1]).toBe("b".repeat(150));
	});

	test("an empty answer renders to zero chunks", () => {
		expect(renderChunks("", caps({ format: "markdown" }))).toEqual([]);
	});
});
