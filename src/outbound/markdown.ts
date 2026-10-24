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
 * Every EMITTED chunk respects the limit: the close suffix a
 * fence-interior chunk carries ("\n```") is reserved in each fit
 * check, and hard-split pieces shrink by the ACTUAL reopen width
 * (info string included — "typescript" reopens 13 chars wide, so a
 * fixed reserve under-sizes pieces).
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
	/** The close suffix a chunk ending inside an open fence carries
	 *  ("\n```") — reserved in EVERY fit check so an emitted chunk can
	 *  never exceed the limit (the reservation is pessimistic: a chunk
	 *  the input's own close line terminates simply comes out smaller). */
	const CLOSE_COST = 4;

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

	/**
	 * Close the current chunk and reopen the fence when one is open —
	 * the shared split point for every path that starts a fresh chunk
	 * (line overflow, paragraph boundary, hard-split pieces).
	 */
	const closeAndReopen = (): void => {
		flush();
		if (fenceOpen) {
			const reopen = fenceReopen();
			current.push(reopen);
			currentLength = reopen.length;
		}
	};

	const pushLine = (line: string, lineLength: number): void => {
		// A chunk that STARTS inside an open fence carries the reopen as
		// its head line — the well-formed invariant (every chunk is a
		// standalone fence) holds no matter which path emptied the chunk.
		if (current.length === 0 && fenceOpen) {
			const reopen = fenceReopen();
			current.push(reopen);
			currentLength = reopen.length;
		}
		const joinCost = current.length === 0 ? 0 : 1;
		const closeCost = fenceOpen ? CLOSE_COST : 0;
		if (currentLength + joinCost + lineLength + closeCost <= limit) {
			current.push(line);
			currentLength += joinCost + lineLength;
			return;
		}
		// The line does not fit: split the chunk (close + reopen when a
		// fence is open), then place the line — hard-splitting it when
		// even a fresh chunk cannot hold reopen + line + close.
		closeAndReopen();
		const prefixCost = fenceOpen ? currentLength + 1 : 0;
		if (prefixCost + lineLength + closeCost <= limit) {
			current.push(line);
			currentLength += (prefixCost === 0 ? 0 : 1) + lineLength;
			return;
		}
		// The line alone exceeds even a fresh chunk's budget: hard-split
		// it (the reopen prefix is dropped first — hardSplit re-arms its
		// own reopen per piece, so every piece's overhead is accounted).
		current = [];
		currentLength = 0;
		hardSplit(line);
	};

	/**
	 * Hard-split one overlong line into pieces sized for the fence
	 * overhead (the ACTUAL info string, not a fixed reserve). Each piece
	 * chunk carries reopen + join + piece + close when a fence is open,
	 * so the piece limit is the limit minus that overhead — and every
	 * piece chunk STARTS with the reopen (the prefix is armed per piece,
	 * never inherited from a dropped head).
	 */
	const hardSplit = (line: string): void => {
		const reopen = fenceOpen ? fenceReopen() : undefined;
		const overhead = reopen === undefined ? 0 : reopen.length + 1 + CLOSE_COST;
		const pieceLimit = Math.max(1, limit - overhead);
		const emit = (piece: string): void => {
			if (reopen === undefined) {
				current.push(piece);
				currentLength = piece.length;
			} else {
				current.push(reopen, piece);
				currentLength = reopen.length + 1 + piece.length;
			}
			// flush appends the close when a fence is open; the next piece
			// re-arms its own reopen.
			flush();
		};
		let start = 0;
		for (;;) {
			const remaining = line.length - start;
			if (remaining <= pieceLimit) {
				emit(line.slice(start));
				return;
			}
			emit(line.slice(start, start + pieceLimit));
			start += pieceLimit;
		}
	};

	let paragraphBreak = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			// A blank line: a paragraph boundary candidate — INSIDE a fence
			// too (the split still closes and reopens, keeping every chunk
			// well-formed; a mid-fence blank line is content, but a split
			// point there is honest when the chunk is full).
			if (current.length > 0) paragraphBreak = true;
			continue;
		}
		if (paragraphBreak) {
			// Split at the paragraph boundary: close (+ reopen inside a
			// fence) so the next chunk starts well-formed. Fence marker
			// lines arrive here too — a blank line before a close marker
			// still splits with the pair.
			if (current.length > 0) closeAndReopen();
			paragraphBreak = false;
		}
		const fenceMatch = /^```(.*)$/.exec(trimmed);
		if (fenceMatch !== null) {
			if (!fenceOpen) {
				// Opening a fence: the info string rides the reopen prefix. The
				// marker line is pushed RAW (the reopen arming in pushLine must
				// not duplicate it — the marker IS the chunk's fence head).
				fenceOpen = true;
				openFence = fenceMatch[1] ?? "";
				openFence = openFence === "" ? undefined : openFence;
				const marker =
					"```" + (openFence === undefined ? "" : openFence);
				const joinCost = current.length === 0 ? 0 : 1;
				const closeCost = CLOSE_COST;
				if (currentLength + joinCost + marker.length + closeCost <= limit) {
					current.push(marker);
					currentLength += joinCost + marker.length;
				} else {
					// The marker does not fit: close the current chunk; the
					// marker starts the fresh one (a chunk-broken fence is still
					// well-formed — flush closes what was open, the marker opens).
					flush();
					current.push(marker);
					currentLength = marker.length;
				}
				continue;
			}
			// Closing a fence: when the current chunk is empty (or holds only
			// the armed reopen), the PREVIOUS chunk's flush suffix already
			// closed the fence — emitting the marker would add an empty-fence
			// chunk, so it is dropped. Otherwise the marker lands normally,
			// WITHOUT arming a fresh reopen when it overflows (the close is
			// terminal: a reopened fence just to hold its own terminator is
			// noise).
			const onlyReopen =
				current.length === 1 && current[0] === fenceReopen();
			if (current.length === 0 || onlyReopen) {
				current = [];
				currentLength = 0;
			} else {
				const joinCost = current.length === 0 ? 0 : 1;
				if (currentLength + joinCost + 3 <= limit) {
					current.push("```");
					currentLength += joinCost + 3;
				} else {
					// The marker does not fit: the chunk closes WITHOUT arming a
					// reopen (fenceOpen flips to false first, so flush's suffix
					// closes what stands).
					fenceOpen = false;
					flush();
				}
			}
			fenceOpen = false;
			openFence = undefined;
			continue;
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
	const text = line.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_all, label: string, url: string) => `${label} (${url})`,
	);
	// Bold + italics markers (`**`, `__`, `*`, `_` pairs).
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		// Inline code markers.
		.replace(/`([^`]+)`/g, "$1");
}
