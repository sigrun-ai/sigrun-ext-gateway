/**
 * Engine logging + id hashing (spec §8.0/§8.12): one scoped console
 * logger with a per-process `once` dedupe (per-key — a repeated warn
 * fires a single line, never one per event), and `hashId` — the
 * non-reversible form sender ids take in status output.
 */
import { createHash } from "node:crypto";
/** The irreversible form a platform sender id takes in operator-facing output. */
export function hashId(id) {
    return createHash("sha256").update(id).digest("hex").slice(0, 16);
}
/** The emitted-once keys this process has already logged. */
const onceLogged = new Set();
/** Build the scoped console logger (the `gateway:` prefix names the engine). */
export function createLog(scope) {
    const prefix = `gateway: ${scope}`.trim();
    return {
        info: (msg) => console.info(`${prefix} ${msg}`),
        warn: (msg) => console.warn(`${prefix} ${msg}`),
        error: (msg, error) => {
            if (error === undefined)
                console.error(`${prefix} ${msg}`);
            else
                console.error(`${prefix} ${msg}`, error);
        },
        // debug rides the console's debug channel: visible when the
        // environment enables it, silent otherwise.
        debug: (msg) => console.debug(`${prefix} ${msg}`),
        once: (key, level, msg) => {
            const onceKey = `${prefix} ${key}`;
            if (onceLogged.has(onceKey))
                return;
            onceLogged.add(onceKey);
            if (level === "info")
                console.info(`${prefix} ${msg}`);
            else
                console.warn(`${prefix} ${msg}`);
        },
    };
}
