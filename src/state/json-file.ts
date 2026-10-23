/**
 * JsonFile<T> — the engine's state-file primitive (spec §8.0: state
 * lives in `<stateDir>/gateway/`, core never reads or writes it).
 *
 * - serialized updates: every `update` runs read → mutate → write inside
 *   ONE queue position, so concurrent updates interleave never (a
 *   lost-update on a state file would silently drop links/bindings);
 * - atomic write: staged temp + rename in the same directory (a crash or
 *   concurrent reader sees the old complete file or the new complete
 *   file, never a half-written one);
 * - mode 0600: state carries identity links, so group/other read is off;
 * - malformed file THROWS naming the path — a corrupt state file is
 *   never silently reset by the next write (the sigrun stores contract).
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A serialized JSON state file at `path`. */
export class JsonFile<T> {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly path: string,
		private readonly initial: () => T,
	) {}

	/** Read the file (absent → the initial value; malformed → throws naming the path). */
	read(): Promise<T> {
		return this.enqueue(async () => this.readNow());
	}

	/**
	 * Read-modify-write under the serialization queue: the mutator runs
	 * on the CURRENT state, the result is written atomically, and the new
	 * state returns. A throwing mutator leaves the file untouched.
	 */
	update(mutate: (draft: T) => void | Promise<void>): Promise<T> {
		return this.enqueue(async () => {
			const draft = await this.readNow();
			await mutate(draft);
			await this.writeNow(draft);
			return draft;
		});
	}

	/** Run `work` after every earlier queued operation (the serialization). */
	private enqueue<R>(work: () => Promise<R>): Promise<R> {
		const next = this.queue.then(work, work);
		// The queue only tracks completion order; a rejection must not
		// poison later operations (they re-read the file for truth).
		this.queue = next.catch(() => {});
		return next;
	}

	private async readNow(): Promise<T> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return this.initial();
			}
			throw error;
		}
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(
				`gateway: malformed JSON in ${this.path}: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	/**
	 * Atomic replace: stage to a fresh temp file in the target's directory
	 * (rename is same-filesystem atomic), stamp 0600 on the temp BEFORE
	 * the rename (chmod beats `writeFile`'s umask-masked `mode`), then
	 * rename over the target. The parent dir is created when absent —
	 * the engine's start creates the state dir, but a JsonFile handed a
	 * deeper path stays usable on a fresh deployment.
	 */
	private async writeNow(value: T): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, {
				mode: 0o600,
			});
			await chmod(temp, 0o600);
			await rename(temp, this.path);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {
				// Best-effort cleanup of the staged temp; the failure being
				// handled is the original one.
			});
			throw error;
		}
	}
}
