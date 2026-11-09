/**
 * Gateway configuration (spec §8.1): core's checked schema read, plus the
 * cross-field rules JSON Schema cannot express. Core applies every scalar
 * default and repairs malformed stored values; this module retains
 * `selfLink`'s dm-dependent default and the anyone-group rules.
 */
import { GATEWAY_SETTINGS_JSON_SCHEMA } from "./settings-schema.js";
/** Default media cap (16 MiB — the readFile ceiling, spec §8.1). */
export const DEFAULT_MEDIA_MAX_BYTES = 16_777_216;
const declaredByHost = new WeakMap();
/** Declare gateway settings ONCE, at the top of the factory. */
export function declareSettings(host) {
    const declared = host.settings.declare({ schema: GATEWAY_SETTINGS_JSON_SCHEMA });
    declaredByHost.set(host, declared);
    return declared;
}
/** Apply the gateway's cross-field rules to an already-checked object. */
export function resolveGatewayConfig(raw) {
    const channels = {};
    if (isRecord(raw.channels)) {
        for (const [id, block] of Object.entries(raw.channels)) {
            channels[id] = typeof block.failed === "string"
                ? { failed: block.failed }
                : resolveChannel(block);
        }
    }
    const media = isRecord(raw.media) && typeof raw.media.maxBytes === "number"
        ? raw.media.maxBytes
        : DEFAULT_MEDIA_MAX_BYTES;
    const home = isRecord(raw.notify) && typeof raw.notify.home === "boolean" ? raw.notify.home : true;
    return { channels, media: { maxBytes: media }, notify: { home } };
}
/** Read the config LIVE through the factory's declared checked-read handle. */
export async function readConfig(host) {
    const declared = declaredByHost.get(host);
    if (declared === undefined)
        throw new Error("readConfig before the factory declared settings");
    return resolveGatewayConfig(await declared.get());
}
function resolveChannel(value) {
    const dm = value.dm;
    return {
        enabled: value.enabled,
        dm,
        selfLink: value.selfLink === undefined ? dm === "pairing" : value.selfLink,
        allow: value.allow,
        groups: value.groups.map(resolveGroup),
        busy: value.busy,
        stream: value.stream,
        allowBots: value.allowBots,
    };
}
function resolveGroup(value) {
    const chat = value.chat;
    const members = value.members;
    const tools = value.tools;
    let extensions = value.extensions;
    if (members === "anyone") {
        // An open group without a pinned tool set would run the full default
        // agent for untrusted senders (spec §8.1). Only this GROUP fails.
        if (tools === undefined || tools.length === 0) {
            return { chat, failed: `group "${chat}" members: "anyone" requires a non-empty tools array` };
        }
        // The gateway's own prompt section rides along on anyone groups (§8.10).
        if (extensions !== undefined && !extensions.includes("gateway"))
            extensions = [...extensions, "gateway"];
    }
    return {
        chat,
        owner: value.owner,
        mention: value.mention,
        members,
        ...(tools === undefined ? {} : { tools }),
        ...(extensions === undefined ? {} : { extensions }),
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
