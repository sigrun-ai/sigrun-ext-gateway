/**
 * The seen set (spec §8.4 step 2): the 24-hour message dedupe, persisted
 * at `<stateDir>/gateway/seen.json`. IN-FLIGHT-AWARE: a claimed id
 * stays unclaimable until its admission settles (commit on success,
 * release on engine failure), so a platform webhook retry racing the
 * first `receive` resolves `"dropped"` — never a double submission
 * (Review Focus 1). Entries older than 86 400 000 ms are dropped on
 * every write (the window sweep rides the write; no timers).
 */

import { JsonFile } from "./json-file.js";

/** The dedupe window (ms) — the plan's pinned 24 h. */
const WINDOW_MS = 86_400_000;

/** The persisted shape of `seen.json`: id → commit time (clock ms). */
type SeenFile = Record<string, number>;

/**
 * The dedupe set, one instance per engine. `claim`/`release` are
 * synchronous (the in-flight set is memory-only); `commit` persists.
 * The window prune runs inside every `commit`'s queued write, so the
 * file never grows past a day of ids even on a long-lived engine.
 */
export class SeenSet {
	private readonly file: JsonFile<SeenFile>;
	private readonly inFlight = new Set<string>();

	constructor(path: string) {
		this.file = new JsonFile<SeenFile>(path, () => ({}));
		// The committed view loads SYNCHRONOUSLY at construction: a second
		// instance over the same file (the restart path) must reject a
		// redelivered id from its first `claim` — the constructor cannot
		// await, and the queue is empty here so nothing can interleave.
		this.observed = this.file.readSync();
	}

	/**
	 * Try to claim `id` as of `now`: true when neither in flight nor
	 * committed inside the window; false otherwise. A true claim marks
	 * the id in flight until `commit` or `release`.
	 */
	claim(id: string, now: number): boolean {
		if (this.inFlight.has(id)) return false;
		if (this.committedWithin(id, now)) return false;
		this.inFlight.add(id);
		return true;
	}

	/** Release an in-flight claim (the admission failed — the platform
	 *  redelivers, so the id must be claimable again). */
	release(id: string): void {
		this.inFlight.delete(id);
	}

	/** Durably mark `id` seen at `now` (the admission settled). */
	async commit(id: string, now: number): Promise<void> {
		this.inFlight.delete(id);
		const draft = await this.file.update((state) => {
			state[id] = now;
			// The window sweep: entries older than the window are dropped on
			// every write, so the file carries at most one day of ids.
			for (const [key, at] of Object.entries(state)) {
				if (now - at > WINDOW_MS) delete state[key];
			}
		});
		// The post-write state IS the committed view a later claim reads
		// (the update returned the written draft).
		this.observed = draft;
	}

	/** Is `id` committed within the window of `now`? (In-memory read of
	 *  the last observed state; the file is re-read inside `commit`'s
	 *  queue — the constructor cannot await, so the first commit loads.) */
	private committedWithin(id: string, now: number): boolean {
		const at = this.observed[id];
		return at !== undefined && now - at <= WINDOW_MS;
	}

	/**
	 * The committed view: loaded at construction (readSync) and refreshed
	 * after every queued `commit` (the update's written draft IS the new
	 * committed state).
	 */
	private observed: SeenFile = {};
}
