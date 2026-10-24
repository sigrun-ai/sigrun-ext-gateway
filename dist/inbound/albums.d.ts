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
export declare const ALBUM_WINDOW_MS = 1500;
/**
 * The in-flight album collector, one instance per engine. `add` returns
 * `undefined` while the album stays OPEN (the caller holds the event
 * back — no submission yet) and the collected envelope texts when the
 * group is COMPLETE (the caller submits them as one submission). A
 * follow-up event with no `groupId` always returns a single-element
 * array immediately.
 */
export declare class AlbumCollector {
    private readonly now;
    private readonly windowMs;
    private readonly groups;
    constructor(now: () => number, windowMs?: number);
    /**
     * Offer one event's envelope text; the return decides submission.
     * `undefined` = still collecting (the caller resolves its receive as
     * admitted-without-submit — the merged submission is pending); an
     * array = the complete set to submit as one.
     */
    add(key: string, event: InboundEvent, text: string): string[] | undefined;
    /**
     * Close the group for `key`/`groupId` NOW: returns the collected
     * texts (empty when none). Two callers: the pipeline's per-group
     * window timer (the elapsed 1500 ms) and the pipeline's
     * `flushAlbums` (the engine's `stopIntake` — an admission in flight
     * must not be dropped at shutdown; the flush submits every open
     * group's merged batch before intake closes).
     */
    close(key: string, groupId: string): string[];
    /** Is a group OPEN (collecting) for `key`/`groupId`? */
    isOpen(key: string, groupId: string): boolean;
}
