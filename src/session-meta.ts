/**
 * The core session-meta document token, re-declared structurally from
 * the shared wire type. Standalone doc tokens compare by kind/scope;
 * declaring it here avoids a runtime import of core's server modules.
 * Version drift is real: pi-durable's checkRecordVersion throws BOTH
 * directions (a newer stored doc, or an older one with no migration),
 * so the engine reads job meta through readJobMeta — a throwing read
 * degrades to absent-meta (logged once) rather than failing the
 * settled fan-out and losing the job delivery.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/views";

export const SessionMetaDoc = defineDoc<SessionMeta>({
	kind: "sigrun.session-meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "user",
	}),
});

/**
 * Read job meta conservatively: a version-drift throw (or any other
 * document-read failure) logs the cause ONCE and returns undefined,
 * so job delivery skips cleanly instead of breaking the fan-out.
 */
export async function readJobMeta<T>(
	read: () => Promise<T>,
	warn: (message: string) => void,
): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		warn(`session-meta read failed; job meta treated as absent: ${String(error)}`);
		return undefined;
	}
}
