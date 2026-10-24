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
export declare const ALBUM_WINDOW_MS = 1500;
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
export declare class AlbumCollector {
    private readonly now;
    private readonly windowMs;
    private readonly groups;
    constructor(now: () => number, windowMs?: number);
    /** Offer one event's envelope text; undefined means still collecting. */
    add(key: string, event: InboundEvent, text: string): AlbumBatch | undefined;
    /** Close and remove one open group, returning its complete batch. */
    close(key: string, groupId: string): AlbumBatch;
    /** Is a group OPEN (collecting) for `key`/`groupId`? */
    isOpen(key: string, groupId: string): boolean;
}
