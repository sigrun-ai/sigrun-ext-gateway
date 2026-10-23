/**
 * Gateway configuration (spec §8.1): `settings/gateway.json` through the
 * engine's scoped settings store, parsed PER READ (live config — every
 * field except a group's `tools`/`extensions` is read per event).
 *
 * Malformed-config posture: a malformed block for one channel or group
 * disables THAT channel or group with the reason (the `{failed}` forms)
 * and never affects its siblings; malformed top-level scalars fall back
 * to their defaults. The parser never throws.
 *
 * Types are imported from `@sigrun/sigrun/extension` type-only (the
 * types-in-main-package contract); this module's runtime imports are
 * none — it is a pure function over a parsed-JSON object.
 */
/** Default media cap (16 MiB — the readFile ceiling, spec §8.1). */
export const DEFAULT_MEDIA_MAX_BYTES = 16_777_216;
/** Parse the raw settings object into the validated {@link GatewayConfig}. */
export function parseGatewayConfig(raw) {
    return {
        channels: parseChannels(raw.channels),
        media: parseMedia(raw.media),
        notify: parseNotify(raw.notify),
    };
}
/**
 * Read the config LIVE through the engine's scoped settings store: the
 * store's object parsed per call, so an operator's edit takes effect on
 * the next event without a restart (only `enabled` is restart-required).
 */
export async function readConfig(host) {
    const raw = await host.stores.settings.get();
    return parseGatewayConfig(raw);
}
// ---------------------------------------------------------------------------
// Channel parsing
// ---------------------------------------------------------------------------
function parseChannels(value) {
    if (!isRecord(value))
        return {};
    const channels = {};
    for (const [id, block] of Object.entries(value)) {
        channels[id] = parseChannel(block, id);
    }
    return channels;
}
function parseChannel(value, id) {
    if (!isRecord(value)) {
        return { failed: `channel "${id}" config is not an object` };
    }
    if (value.dm !== undefined && !isDmPolicy(value.dm)) {
        return {
            failed: `channel "${id}" dm must be "pairing" | "allowlist" | "disabled"`,
        };
    }
    const dm = value.dm === undefined ? "pairing" : value.dm;
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        return { failed: `channel "${id}" enabled must be a boolean` };
    }
    if (value.busy !== undefined &&
        value.busy !== "followUp" &&
        value.busy !== "steer") {
        return { failed: `channel "${id}" busy must be "followUp" | "steer"` };
    }
    const allow = parseAllow(value.allow, id);
    if (typeof allow === "string")
        return { failed: allow };
    const groups = parseGroups(value.groups, id);
    if (typeof groups === "string")
        return { failed: groups };
    if (value.selfLink !== undefined && typeof value.selfLink !== "boolean") {
        return { failed: `channel "${id}" selfLink must be a boolean` };
    }
    if (value.stream !== undefined && typeof value.stream !== "boolean") {
        return { failed: `channel "${id}" stream must be a boolean` };
    }
    if (value.allowBots !== undefined && typeof value.allowBots !== "boolean") {
        return { failed: `channel "${id}" allowBots must be a boolean` };
    }
    // selfLink defaults true for pairing channels, false otherwise (spec
    // §8.1: an allowlist channel's operator chose a closed list).
    const selfLinkDefault = dm === "pairing";
    return {
        enabled: value.enabled === undefined ? true : value.enabled,
        dm,
        selfLink: value.selfLink === undefined ? selfLinkDefault : value.selfLink,
        allow,
        groups,
        busy: value.busy === undefined ? "followUp" : value.busy,
        stream: value.stream === undefined ? true : value.stream,
        allowBots: value.allowBots === undefined ? false : value.allowBots,
    };
}
function isDmPolicy(value) {
    return value === "pairing" || value === "allowlist" || value === "disabled";
}
function parseAllow(value, id) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        return `channel "${id}" allow must be an array`;
    }
    const entries = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            return `channel "${id}" allow entries must be objects`;
        }
        if (typeof entry.sender !== "string" || entry.sender === "") {
            return `channel "${id}" allow entries need a non-empty string sender`;
        }
        if (typeof entry.user !== "string" || entry.user === "") {
            return `channel "${id}" allow entries need a non-empty string user`;
        }
        entries.push({ sender: entry.sender, user: entry.user });
    }
    return entries;
}
function parseGroups(value, id) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        return `channel "${id}" groups must be an array`;
    }
    return value.map((group) => parseGroup(group));
}
function parseGroup(value) {
    if (!isRecord(value)) {
        return { chat: "", failed: "group config is not an object" };
    }
    // The failed-group form still names WHICH chat failed: an absent or
    // non-string chat renders as the empty string so the row is shaped.
    const chat = typeof value.chat === "string" ? value.chat : "";
    if (chat === "") {
        return { chat, failed: "group needs a non-empty string chat" };
    }
    if (typeof value.owner !== "string" || value.owner === "") {
        return { chat, failed: `group "${chat}" needs a non-empty string owner` };
    }
    if (value.mention !== undefined &&
        value.mention !== "required" &&
        value.mention !== "always") {
        return {
            chat,
            failed: `group "${chat}" mention must be "required" | "always"`,
        };
    }
    if (value.members !== undefined &&
        value.members !== "linked" &&
        value.members !== "anyone") {
        return {
            chat,
            failed: `group "${chat}" members must be "linked" | "anyone"`,
        };
    }
    const members = value.members === undefined ? "linked" : value.members;
    if (value.tools !== undefined && !isStringArray(value.tools)) {
        return {
            chat,
            failed: `group "${chat}" tools must be an array of strings`,
        };
    }
    if (value.extensions !== undefined && !isStringArray(value.extensions)) {
        return {
            chat,
            failed: `group "${chat}" extensions must be an array of strings`,
        };
    }
    const tools = value.tools;
    let extensions = value.extensions;
    if (members === "anyone") {
        // Spec §8.1: "anyone" REQUIRES a non-empty tools array — an open
        // group without a pinned tool set would run the full default agent
        // for untrusted senders.
        if (tools === undefined || tools.length === 0) {
            return {
                chat,
                failed: `group "${chat}" members: "anyone" requires a non-empty tools array`,
            };
        }
        // Spec §8.10: the gateway's own prompt section rides along on
        // anyone groups (the model must see its chat context).
        if (extensions !== undefined && !extensions.includes("gateway")) {
            extensions = [...extensions, "gateway"];
        }
    }
    return {
        chat,
        owner: value.owner,
        mention: value.mention === undefined ? "required" : value.mention,
        members,
        ...(tools === undefined ? {} : { tools }),
        ...(extensions === undefined ? {} : { extensions }),
    };
}
// ---------------------------------------------------------------------------
// Media / notify parsing
// ---------------------------------------------------------------------------
function parseMedia(value) {
    if (isRecord(value) &&
        typeof value.maxBytes === "number" &&
        value.maxBytes > 0) {
        return { maxBytes: value.maxBytes };
    }
    return { maxBytes: DEFAULT_MEDIA_MAX_BYTES };
}
function parseNotify(value) {
    if (isRecord(value) && typeof value.home === "boolean") {
        return { home: value.home };
    }
    return { home: true };
}
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
    return (Array.isArray(value) && value.every((item) => typeof item === "string"));
}
