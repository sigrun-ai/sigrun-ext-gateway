/**
 * sigrun-ext-gateway: the gateway engine factory (the loader contract).
 *
 * The sigrun extension-package contract: the default export is a factory
 * DECLARING the host parameter (arity 1 — the host rule; a length-0
 * factory with a defaulted first parameter would consume the host as
 * that dependency), returning `{ extension, gateway }`.
 *
 * The extension is a bare `defineExtension({ name: "gateway" })` for
 * Task 1: the prompt section (§8.10) and the `send_message`/`list_chats`
 * tools (§8.9) land with the tasks that own them. The `gateway` engine
 * is built over the host at factory time (cheap closure wiring — no
 * timers, no I/O; the pi lifecycle rule: the factory registers handlers
 * only, `start` runs after the server listens).
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { createEngine } from "./engine.js";
/**
 * The sigrun extension-package factory: builds the engine over the host.
 * One factory call, one engine (the one-engine rule holds at the loader:
 * a second declarer quarantines).
 */
export default function createGateway(host) {
    const engine = createEngine(host);
    return {
        extension: defineExtension({ name: "gateway" }),
        gateway: engine,
    };
}
export { createEngine } from "./engine.js";
export { parseGatewayConfig, readConfig, DEFAULT_MEDIA_MAX_BYTES, } from "./config.js";
export { JsonFile } from "./state/json-file.js";
export { createLog, hashId } from "./log.js";
