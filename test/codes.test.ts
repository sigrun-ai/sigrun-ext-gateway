/**
 * Pairing/link code primitives (spec §8.2): the 8-character code from
 * the 32-character unambiguous alphabet, and the normalizer that folds
 * user-typed codes (whitespace, separators, case) onto the canonical
 * form before any comparison.
 *
 * Tests own their literals: codes are only ever read at runtime — no
 * fixture asserts a literal code value, only shape.
 */

import { describe, expect, test } from "vitest";
import { CODE_ALPHABET, newCode, normalizeCode } from "../src/access/codes.js";

describe("codes (spec §8.2)", () => {
	test("the alphabet is the 32-character unambiguous set", () => {
		expect(CODE_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
		expect(CODE_ALPHABET).toHaveLength(32);
	});

	test("newCode is 8 characters from the alphabet", () => {
		for (let i = 0; i < 20; i++) {
			const code = newCode();
			expect(code).toHaveLength(8);
			for (const char of code) {
				expect(CODE_ALPHABET).toContain(char);
			}
		}
	});

	test("newCode draws more than one value across a batch (randomness sanity)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 20; i++) seen.add(newCode());
		expect(seen.size).toBeGreaterThan(1);
	});

	test("normalizeCode uppercases and drops separators/non-alphabet characters", () => {
		expect(normalizeCode(" abcd-efgh ")).toBe("ABCDEFGH");
		expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH");
		expect(normalizeCode("ab0i1o")).toBe("AB");
		expect(normalizeCode("  ")).toBe("");
	});
});
