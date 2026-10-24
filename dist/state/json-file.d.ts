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
/** A serialized JSON state file at `path`. */
export declare class JsonFile<T> {
    private readonly path;
    private readonly initial;
    private queue;
    constructor(path: string, initial: () => T);
    /** Read the file (absent → the initial value; malformed → throws naming the path). */
    read(): Promise<T>;
    /**
     * The synchronous read: the same semantics as {@link read} (absent →
     * the initial value; malformed → throws naming the path) without the
     * queue. Stores whose READ API is synchronous (the binding/identity
     * reads the plan pins) load at construction this way — the queue is
     * empty then, so nothing can interleave; a queued write's own state
     * tracking refreshes the store's mirror afterward.
     */
    readSync(): T;
    /**
     * Read-modify-write under the serialization queue: the mutator runs
     * on the CURRENT state, the result is written atomically, and the new
     * state returns. A throwing mutator leaves the file untouched.
     */
    update(mutate: (draft: T) => void | Promise<void>): Promise<T>;
    /** Run `work` after every earlier queued operation (the serialization). */
    private enqueue;
    private readNow;
    /**
     * Atomic replace: stage to a fresh temp file in the target's directory
     * (rename is same-filesystem atomic), stamp 0600 on the temp BEFORE
     * the rename (chmod beats `writeFile`'s umask-masked `mode`), then
     * rename over the target. The parent dir is created when absent —
     * the engine's start creates the state dir, but a JsonFile handed a
     * deeper path stays usable on a fresh deployment.
     */
    private writeNow;
}
