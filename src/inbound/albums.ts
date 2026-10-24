/**
 * Album merging (spec §8.4 step 6): events sharing a `groupId` that
 * arrive within 1500 ms merge into ONE submission (a platform media
 * group delivered as several events). There is no time-based burst
 * merging otherwise — every non-album message submits on arrival.
 *
 * The window runs from the FIRST event of its group: the group is
 * closed once a later sibling arrives past `firstAt + 1500`, and a
 * `groupId` reused later opens a NEW group. Group state is per
 * binding key (the chat) — two chats never share an album.
 */

import type { InboundEvent } from "@sigrun/sigrun/extension";

/** The album merge window (ms) — the plan's pinned 1.5 s. */
export const ALBUM_WINDOW_MS = 1_500;

/**
 * The in-flight album collector, one instance per engine. `add` returns
 * `undefined` while the album stays OPEN (the caller holds the event
 * back — no submission yet) and the collected envelope texts when the
 * group is COMPLETE (the caller submits them as one submission). A
 * follow-up event with no `groupId` always returns a single-element
 * array immediately.
 */
export class AlbumCollector {
	private readonly groups = new Map<
		string,
		{ texts: string[]; firstAt: number }
	>();

	constructor(
		private readonly now: () => number,
		private readonly windowMs: number = ALBUM_WINDOW_MS,
	) {}

	/**
	 * Offer one event's envelope text; the return decides submission.
	 * `undefined` = still collecting (the caller resolves its receive as
	 * admitted-without-submit — the merged submission is pending); an
	 * array = the complete set to submit as one.
	 */
	add(key: string, event: InboundEvent, text: string): string[] | undefined {
		if (event.groupId === undefined) {
			// A plain event never joins an album: one-element batch, now.
			return [text];
		}
		const at = this.now();
		const group = this.groups.get(`${key}:${event.groupId}`);
		if (group === undefined || at - group.firstAt > this.windowMs) {
			// A fresh group (or the prior one long closed): hold the event
			// for the window so its siblings can join.
			this.groups.set(`${key}:${event.groupId}`, {
				texts: [text],
				firstAt: at,
			});
			return undefined;
		}
		group.texts.push(text);
		// Siblings beyond the window's first event submit as a new group;
		// the in-window batch closes here (the caller owns the timing of
		// the last sibling — see `close`).
		return undefined;
	}

	/**
	 * Close the group for `key`/`groupId` NOW: returns the collected
	 * texts (empty when none). Called when the window elapsed — the
	 * pipeline's per-group timer — or on the engine's stopIntake (an
	 * admission in flight must not be dropped at shutdown).
	 */
	close(key: string, groupId: string): string[] {
		const group = this.groups.get(`${key}:${groupId}`);
		if (group === undefined) return [];
		this.groups.delete(`${key}:${groupId}`);
		return group.texts;
	}

	/** Is a group OPEN (collecting) for `key`/`groupId`? */
	isOpen(key: string, groupId: string): boolean {
		return this.groups.has(`${key}:${groupId}`);
	}
}
