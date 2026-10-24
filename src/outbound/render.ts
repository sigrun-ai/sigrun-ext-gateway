/**
 * renderChunks (spec §8.6's three-step order, verbatim):
 *
 * 1. Split the markdown final at `maxMessageLength` (paragraph, line,
 *    hard — {@link splitMarkdown}, with the fence close/reopen rule).
 * 2. Format each chunk per `capabilities.format`: `markdown` as-is,
 *    `native` through the adapter's `format`, `plain` through the
 *    engine's markdown stripper.
 * 3. A formatted chunk that STILL exceeds `maxMessageLength` (native
 *    markup grew it) is hard-split.
 *
 * Empty input renders to zero chunks (the caller owns the empty-answer
 * notice — Review Focus 4).
 */

import type { ChannelCapabilities } from "@sigrun/sigrun/extension";
import { splitMarkdown, stripMarkdown } from "./markdown.js";

/**
 * Render the markdown final into platform-ready chunks. `format` is the
 * adapter's formatter (`ChannelContribution.format`), required only for
 * `native` capabilities — a missing formatter on a native channel is
 * the loader's contract violation, handled by the caller; here the
 * chunk passes through unformatted (the honest degraded behavior for
 * an adapter that declared native markup and shipped no renderer).
 */
export function renderChunks(
	markdown: string,
	caps: ChannelCapabilities,
	format?: (md: string) => string,
): string[] {
	if (markdown === "") return [];
	// Step 1: split at the platform's message ceiling.
	const split = splitMarkdown(markdown, caps.maxMessageLength);
	// Step 2 + 3: format, then hard-split whatever formatting grew.
	const out: string[] = [];
	for (const chunk of split) {
		const formatted = formatChunk(chunk, caps, format);
		if (formatted.length <= caps.maxMessageLength) {
			out.push(formatted);
			continue;
		}
		// Native markup grew the chunk past the ceiling: hard-split the
		// FORMATTED text (no fence knowledge — the adapter's markup is
		// opaque to the engine; closing it would be guesswork).
		out.push(...hardSplit(formatted, caps.maxMessageLength));
	}
	return out;
}

/** Step 2 for one chunk. */
function formatChunk(
	chunk: string,
	caps: ChannelCapabilities,
	format?: (md: string) => string,
): string {
	switch (caps.format) {
		case "markdown":
			return chunk;
		case "plain":
			return stripMarkdown(chunk);
		case "native":
			return format === undefined ? chunk : format(chunk);
	}
}

/** Hard-split one formatted string at exact `limit` boundaries. */
function hardSplit(text: string, limit: number): string[] {
	const pieces: string[] = [];
	for (let start = 0; start < text.length; start += limit) {
		pieces.push(text.slice(start, start + limit));
	}
	return pieces;
}
