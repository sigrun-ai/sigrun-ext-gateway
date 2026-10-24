/**
 * Markdown splitting and stripping (spec §8.6): the outbound chunker's
 * step 1 (split at paragraph, then line, then hard boundaries, with
 * fence close-and-reopen) and the plain-format renderer's stripper
 * (headings, emphasis, links → `text (url)`, fences → plain blocks).
 *
 * Pure functions over strings — no imports, no clock, no I/O.
 */
/**
 * Split `text` into chunks of at most `limit` characters, preferring
 * paragraph boundaries, then line boundaries, then hard cuts.
 *
 * Fence rule: a code fence cut by a split is CLOSED in the earlier
 * chunk and REOPENED with its original info string at the head of the
 * next. An unterminated fence in the input is treated as running to
 * the end (the last chunk's close terminates it — every emitted chunk
 * is well-formed on its own).
 *
 * The join of the chunks is a lossless representation of the input
 * apart from the inserted fence markers and the whitespace the
 * paragraph/line splits consumed.
 */
export declare function splitMarkdown(text: string, limit: number): string[];
/**
 * Strip markdown to plain text (the `plain` capability's formatter):
 * headings lose their `#` markers, emphasis markers are removed, links
 * render as `text (url)`, and fenced code blocks become their inner
 * lines. Structure (paragraphs, line breaks) is preserved.
 */
export declare function stripMarkdown(text: string): string;
