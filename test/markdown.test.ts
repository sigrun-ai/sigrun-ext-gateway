/**
 * splitMarkdown / stripMarkdown (spec §8.6 step 1 and the plain-format
 * step 2): the paragraph → line → hard ladder, the fence
 * close-and-reopen rule, and the plain-text renderer.
 *
 * Tests own their literals; limits are pinned at 40 chars per the plan.
 */

import { describe, expect, test } from "vitest";
import { splitMarkdown, stripMarkdown } from "../src/outbound/markdown.js";

describe("splitMarkdown (limit 40)", () => {
	test("short text stays one chunk", () => {
		expect(splitMarkdown("hello", 40)).toEqual(["hello"]);
	});

	test("splits at paragraph boundaries first", () => {
		const text = "first paragraph of some length\n\nsecond paragraph here";
		const chunks = splitMarkdown(text, 40);
		expect(chunks).toEqual([
			"first paragraph of some length",
			"second paragraph here",
		]);
	});

	test("falls back to line boundaries within a paragraph", () => {
		// One paragraph, but each line alone fits while the whole does not.
		const text = "alpha line one is long\nbravo line two also long";
		const chunks = splitMarkdown(text, 40);
		expect(chunks).toEqual(["alpha line one is long", "bravo line two also long"]);
	});

	test("hard-splits a single overlong line at the limit", () => {
		const text = "a".repeat(100);
		const chunks = splitMarkdown(text, 40);
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toHaveLength(40);
		expect(chunks[1]).toHaveLength(40);
		expect(chunks[2]).toHaveLength(20);
	});

	test("a fence cut by a split is closed in the earlier chunk and reopened with its info string", () => {
		const code = "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;";
		const text = `Intro line.\n\n\`\`\`ts\n${code}\`\`\`\n\nOutro line closes the message.`;
		const chunks = splitMarkdown(text, 40);
		// The fence body must not silently lose its language tag: the
		// reopened fence carries the original info string.
		const inFence = chunks.filter((c) => c.includes("const z"));
		expect(inFence.length).toBeGreaterThan(0);
		// The cut chunk ends INSIDE the fence, so it closes with a bare fence
		// marker; the chunk AFTER it reopens with the original info string.
		const cut = chunks.find((c) => c.includes("const z"));
		expect(cut?.endsWith("```")).toBe(true);
		const after = chunks[chunks.indexOf(cut!) + 1];
		expect(after).toMatch(/^```ts/);
		// Every chunk reassembles into the same code content.
		expect(chunks.join("\n").replace(/```ts\n?/g, "")).toContain(
			"const w = 4;",
		);
	});

	test("an unterminated fence in the input runs to the end and every chunk is well-formed (Review Focus 5)", () => {
		const text =
			"Start.\n\n```\ninner line one\ninner line two\ninner line three\n" +
			"more inner text here forcing one more cut\n" +
			"final inner line of the unterminated fence";
		const chunks = splitMarkdown(text, 40);
		expect(chunks.length).toBeGreaterThan(1);
		// The LAST chunk terminates the fence (the splitter closes what the
		// model left open — every emitted chunk is well-formed alone).
		expect(chunks.at(-1)?.endsWith("```")).toBe(true);
		// The first fence marker stays in chunk 0.
		expect(chunks[0]).toContain("```");
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(40);
		}
	});

	test("every chunk respects the limit for mixed content", () => {
		const text =
			"# Heading\n\npara one text here\n\npara two text here\n\n" +
			"```js\nconsole.log(1);\nconsole.log(2);\nconsole.log(3);\n```\n\ntail";
		const chunks = splitMarkdown(text, 40);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(40);
		}
	});
});

describe("stripMarkdown", () => {
	test("headings lose their markers", () => {
		expect(stripMarkdown("# Title\n## Sub")).toBe("Title\nSub");
	});

	test("emphasis markers are removed", () => {
		expect(stripMarkdown("**bold** and *italic* and _us_")).toBe(
			"bold and italic and _us_",
		);
	});

	test("links become text (url)", () => {
		expect(stripMarkdown("see [docs](https://example.invalid/x) now")).toBe(
			"see docs (https://example.invalid/x) now",
		);
	});

	test("fences become plain blocks", () => {
		const text = "before\n\n```ts\nconst a = 1;\n```\n\nafter";
		expect(stripMarkdown(text)).toBe("before\n\nconst a = 1;\n\nafter");
	});

	test("plain text passes through unchanged", () => {
		expect(stripMarkdown("just words\nand lines")).toBe("just words\nand lines");
	});
});
