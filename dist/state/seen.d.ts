/**
 * The seen set (spec §8.4 step 2): the 24-hour message dedupe, persisted
 * at `<stateDir>/gateway/seen.json`. IN-FLIGHT-AWARE: a claimed id
 * stays unclaimable until its admission settles (commit on success,
 * release on engine failure), so a platform webhook retry racing the
 * first `receive` resolves `"dropped"` — never a double submission
 * (Review Focus 1). Entries older than 86 400 000 ms are dropped on
 * every write (the window sweep rides the write; no timers).
 */
/**
 * The dedupe set, one instance per engine. `claim`/`release` are
 * synchronous (the in-flight set is memory-only); `commit` persists.
 * The window prune runs inside every `commit`'s queued write, so the
 * file never grows past a day of ids even on a long-lived engine.
 */
export declare class SeenSet {
    private readonly file;
    private readonly inFlight;
    constructor(path: string);
    /**
     * Try to claim `id` as of `now`: true when neither in flight nor
     * committed inside the window; false otherwise. A true claim marks
     * the id in flight until `commit` or `release`.
     */
    claim(id: string, now: number): boolean;
    /** Release an in-flight claim (the admission failed — the platform
     *  redelivers, so the id must be claimable again). */
    release(id: string): void;
    /** Durably mark `id` seen at `now` (the admission settled). */
    commit(id: string, now: number): Promise<void>;
    /** Is `id` committed within the window of `now`? (In-memory read of
     *  the last observed state; the file is re-read inside `commit`'s
     *  queue — the constructor cannot await, so the first commit loads.) */
    private committedWithin;
    /**
     * The committed view: loaded at construction (readSync) and refreshed
     * after every queued `commit` (the update's written draft IS the new
     * committed state).
     */
    private observed;
}
