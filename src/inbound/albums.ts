/**
 * Album merging (spec §8.4 step 6): events sharing a `groupId` that
 * arrive within 1500 ms merge into ONE submission (a platform media
 * group delivered as several events). There is no time-based burst
 * merging otherwise — every non-album message submits on arrival.
 *
 * The window runs from the FIRST event of its group: the group is
 * closed once a later sibling arrives past `firstAt + 1500`, and a
 * `groupId` reused later opens a NEW group. Group state is per
 * binding key (the chat) — two chats never share an album. Attachment
 * arrays are preserved alongside envelope texts so every sibling's
 * media reaches the one submission.
 */

import type { InboundAttachment, InboundEvent } from "@sigrun/sigrun/extension";

/** The album merge window (ms) — the plan's pinned 1.5 s. */
export const ALBUM_WINDOW_MS = 1_500;

/** One complete album, or a plain event's single-item batch. */
export interface AlbumBatch {
	readonly texts: readonly string[];
	readonly attachments: readonly InboundAttachment[];
}

/**
 * The in-flight album collector, one instance per engine. `add` returns
 * `undefined` while the album stays OPEN (the caller holds the event
 * back — no submission yet) and the collected batch when the group is
 * COMPLETE. A follow-up event with no `groupId` returns its own batch.
 */
export class AlbumCollector {
	private readonly groups = new Map<
		string,
		{ texts: string[]; attachments: InboundAttachment[]; firstAt: number }
	>();

	constructor(
		private readonly now: () => number,
		private readonly windowMs: number = ALBUM_WINDOW_MS,
	) {}

	/** Offer one event's envelope text; undefined means still collecting. */
	add(key: string, event: InboundEvent, text: string): AlbumBatch | undefined {
		if (event.groupId === undefined) {
			return { texts: [text], attachments: event.attachments ?? [] };
		}
		const at = this.now();
		const group = this.groups.get(`${key}:${event.groupId}`);
		if (group === undefined || at - group.firstAt > this.windowMs) {
			this.groups.set(`${key}:${event.groupId}`, {
				texts: [text],
				attachments: [...(event.attachments ?? [])],
				firstAt: at,
			});
			return undefined;
		}
		group.texts.push(text);
		group.attachments.push(...(event.attachments ?? []));
		// Every sibling stays held until the timer or shutdown flush.
		return undefined;
	}

	/** Close and remove one open group, returning its complete batch. */
	close(key: string, groupId: string): AlbumBatch {
		const group = this.groups.get(`${key}:${groupId}`);
		if (group === undefined) return { texts: [], attachments: [] };
		this.groups.delete(`${key}:${groupId}`);
		return { texts: group.texts, attachments: group.attachments };
	}

	/** Is a group OPEN (collecting) for `key`/`groupId`? */
	isOpen(key: string, groupId: string): boolean {
		return this.groups.has(`${key}:${groupId}`);
	}
}
