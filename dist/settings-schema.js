/**
 * Gateway settings (settings rework, Task 13): channels, media and home
 * notifications declared as JSON Schema for core's generated settings form
 * and checked read. Authored as raw JSON Schema: TypeBox 1.3 wraps table
 * `additionalProperties` in a nested property the generator cannot read.
 *
 * No credentials live here (channel contributors own adapter credentials),
 * so the schema has no writeOnly fields. The live markers preserve the old
 * parser's per-read behavior; channel `enabled` remains restart-required.
 */
const live = { "x-sigrun-apply": "live" };
const dmPolicy = {
    oneOf: [
        { const: "pairing", title: "Pairing" },
        { const: "allowlist", title: "Allowlist" },
        { const: "disabled", title: "Disabled" },
    ],
    default: "pairing",
    description: "How direct messages are admitted.",
};
const allowEntry = {
    type: "object",
    properties: {
        sender: { type: "string", minLength: 1, description: "The channel sender id to admit." },
        user: { type: "string", minLength: 1, description: "The linked sigrun directory user." },
    },
    required: ["sender", "user"],
    "x-sigrun-key": "sender",
    "x-sigrun-summary": ["sender", "user"],
};
const groupEntry = {
    type: "object",
    properties: {
        chat: { type: "string", minLength: 1, description: "The platform group-chat id." },
        owner: { type: "string", minLength: 1, description: "The directory user whose authority the agent uses." },
        mention: {
            oneOf: [
                { const: "required", title: "Mention required" },
                { const: "always", title: "Always respond" },
            ],
            default: "required",
            description: "Whether group messages must mention the agent.",
        },
        members: {
            oneOf: [
                { const: "linked", title: "Linked users only" },
                { const: "anyone", title: "Anyone (requires pinned tools)" },
            ],
            default: "linked",
            description: "Who may interact with the agent in this group.",
        },
        tools: {
            type: "array",
            items: { type: "string" },
            description: "The group's allowed tool list; required and non-empty for anyone groups.",
        },
        extensions: {
            type: "array",
            items: { type: "string" },
            description: "Extensions enabled for this group (anyone groups also include gateway).",
        },
    },
    required: ["chat", "owner"],
    "x-sigrun-key": "chat",
    "x-sigrun-summary": ["chat", "owner", "mention"],
};
const channel = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "Start this channel adapter at boot." },
        dm: { ...dmPolicy, ...live },
        selfLink: {
            type: "boolean",
            ...live,
            description: "Allow users to link themselves (default: pairing channels only).",
        },
        allow: {
            type: "array",
            items: allowEntry,
            default: [],
            ...live,
            description: "Direct-message allowlist entries.",
        },
        groups: {
            type: "array",
            items: groupEntry,
            default: [],
            ...live,
            description: "Group chats served by this channel.",
        },
        busy: {
            oneOf: [
                { const: "followUp", title: "Follow up" },
                { const: "steer", title: "Steer the current run" },
            ],
            default: "followUp",
            ...live,
            description: "How inbound messages behave while the agent is running.",
        },
        stream: { type: "boolean", default: true, ...live, description: "Stream response previews to the chat." },
        allowBots: { type: "boolean", default: false, ...live, description: "Admit messages sent by other bots." },
    },
    "x-sigrun-summary": ["enabled", "dm", "busy"],
};
export const GATEWAY_SETTINGS_JSON_SCHEMA = {
    type: "object",
    properties: {
        channels: {
            type: "object",
            additionalProperties: channel,
            default: {},
            description: "Channel adapters, keyed by channel id.",
        },
        media: {
            type: "object",
            title: "Media",
            properties: {
                maxBytes: {
                    type: "integer",
                    minimum: 1,
                    default: 16_777_216,
                    ...live,
                    description: "Maximum size of one inbound attachment in bytes.",
                },
            },
        },
        notify: {
            type: "object",
            title: "Notifications",
            properties: {
                home: {
                    type: "boolean",
                    default: true,
                    ...live,
                    description: "Deliver notifications to the user's linked home chat.",
                },
            },
        },
    },
};
