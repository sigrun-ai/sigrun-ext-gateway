/**
 * Pairing/link codes (spec §8.2): 8 characters drawn from a 32-character
 * unambiguous alphabet (no I/O/0/1 — the Hermes/OpenClaw shared
 * parameter set) via `crypto.randomInt`, plus the normalizer that folds
 * user-typed input (whitespace, `-` separators, lowercase) onto the
 * canonical form before any comparison. Codes are NEVER logged.
 */
/** The 32-character unambiguous code alphabet (no I, O, 0, 1). */
export declare const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Draw one code: 8 uniform characters from {@link CODE_ALPHABET}. */
export declare function newCode(): string;
/**
 * Fold user-typed input onto the canonical form: uppercase, then drop
 * every character outside the alphabet (separators, whitespace, the
 * ambiguous glyphs a paste may carry). An input that normalizes to the
 * empty string simply never matches an issued code.
 */
export declare function normalizeCode(input: string): string;
