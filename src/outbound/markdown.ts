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
export function splitMarkdown(text: string, limit: number): string[] {
	if (limit <= 0) {
		// A zero/negative limit has no legal chunk; the caller's config
		// validation owns that error. Hard-splitting into empty strings
		// would loop forever, so the honest fallback is the whole text.
		return text === "" ? [] : [text];
	}
	const lines = text.split("\n");
	const chunks: string[] = [];
	/** The chunk under construction, joined with "\n". */
	let current: string[] = [];
	let currentLength = 0;
	/** Whether a code fence is currently open (independent of its info). */
	let fenceOpen = false;
	/** The open fence's info string (e.g. "ts"), undefined when bare. */
	let openFence: string | undefined;
	/** Reconstructed open-fence line for reopening (with info string). */
	const fenceReopen = (): string =>
		"```" + (openFence === undefined ? "" : openFence);

	const flush = (): void => {
		if (current.length === 0) return;
		let chunk = current.join("\n");
		if (fenceOpen && !chunk.endsWith("```")) {
			// The chunk ends INSIDE a fence: close it so the chunk stands
			// alone (the next chunk reopens).
			chunk += "\n```";
		}
		chunks.push(chunk);
		current = [];
		currentLength = 0;
	};

	const pushLine = (line: string, lineLength: number): void => {
		const joinCost = current.length === 0 ? 0 : 1;
		if (currentLength + joinCost + lineLength <= limit) {
			current.push(line);
			currentLength += joinCost + lineLength;
			return;
		}
		// The line does not fit: close the current chunk, then place the
		// line (hard-splitting it if it alone exceeds the limit).
		flush();
		if (fenceOpen) {
			// Reopen the fence at the head of the new chunk.
			const reopen = fenceReopen();
			current.push(reopen);
			currentLength = reopen.length;
		}
				if (lineLength <= limit) {
						current.push(line);
						currentLength += lineLength;
						return;
				}
				// The line alone exceeds the limit: hard-split it. The reopen
				// prefix pushed above is dropped first — hardSplit re-arms its own
				// reopen per piece, so starting from an empty chunk keeps every
				// piece's overhead accounted.
				current = [];
				currentLength = 0;
				hardSplit(line);
		};

		// Fence overhead: a chunk inside a fence may need a reopen prefix
		// ("\n```" leading) and a close suffix ("\n```"); hard-split pieces
		// shrink by that budget so every EMITTED chunk respects the limit.

		/** Hard-split one overlong line into limit-sized pieces. */
		const hardSplit = (line: string): void => {
				const pieceLimit = Math.max(1, limit - (fenceOpen ? 8 : 0));
		let start = 0;
		for (;;) {
			const remaining = line.length - start;
			if (remaining <= pieceLimit) {
				pushLine(line.slice(start), remaining);
				return;
			}
			const piece = line.slice(start, start + pieceLimit);
			start += pieceLimit;
			// A piece that would end inside a fence still closes at flush;
			// fence bookkeeping happens per LINE below.
			current.push(piece);
			currentLength = piece.length;
			flush();
			if (fenceOpen) {
				const reopen = fenceReopen();
				current.push(reopen);
				currentLength = reopen.length;
			}
		}
	};

	let paragraphBreak = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			// A blank line: a paragraph boundary candidate. Flush on the
			// NEXT non-blank line only when the paragraph after it fits
			// better alone — the simplest honest rule: flush when the
			// current chunk already holds content (paragraphs prefer
			// chunk isolation) AND the text has more content coming.
			if (current.length > 0) paragraphBreak = true;
			continue;
		}
		const fenceMatch = /^```(.*)$/.exec(trimmed);
		if (fenceMatch !== null) {
			if (!fenceOpen) {
				// Opening a fence: the info string rides the reopen prefix.
				fenceOpen = true;
				openFence = fenceMatch[1] ?? "";
				openFence = openFence === "" ? undefined : openFence;
				// Render the canonical opening line (no trailing spaces).
				pushLine(
					"```" + (openFence === undefined ? "" : openFence),
					3 + (openFence === undefined ? 0 : openFence.length),
				);
				continue;
			}
			// Closing a fence.
			pushLine("```", 3);
			fenceOpen = false;
			openFence = undefined;
			continue;
		}
		if (paragraphBreak) {
			// Prefer a paragraph split: the current chunk is closed and the
			// line starts a fresh chunk (the hard-split fallback inside
			// pushLine still applies when the LINE itself overflows).
			const wouldFit =
				currentLength === 0 ||
				currentLength + 1 + line.length <= limit;
			if (currentLength > 0 || !wouldFit) flush();
			paragraphBreak = false;
		}
		pushLine(line, line.length);
	}
	flush();
	// An unterminated fence never emits a trailing empty reopen chunk:
	// flush() already closed whatever chunk ended inside the fence.
	return chunks;
}

/**
 * Strip markdown to plain text (the `plain` capability's formatter):
 * headings lose their `#` markers, emphasis markers are removed, links
 * render as `text (url)`, and fenced code blocks become their inner
 * lines. Structure (paragraphs, line breaks) is preserved.
 */
export function stripMarkdown(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		out.push(stripInline(stripHeading(line)));
	}
	// Collapse the blank lines the fence markers consumed (a fence's
	// open/close lines leave consecutive blanks around the block).
	return out.join("\n");
}

/** Drop a heading's leading `#` run (ATX headings only). */
function stripHeading(line: string): string {
	const match = /^(#{1,6})\s+(.*)$/.exec(line);
	return match === null ? line : match[2] ?? "";
}

/** Strip emphasis and rewrite links on ONE line. */
function stripInline(line: string): string {
	// Links first: their text may carry emphasis.
	let text = line.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_all, label: string, url: string) => `${label} (${url})`,
	);
	// Bold + italics markers (`**`, `__`, `*`, `_` pairs).
	text = text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1");
	// Inline code markers.
	text = text.replace(/`([^`]+)`/g, "$1");
	return text;
}
