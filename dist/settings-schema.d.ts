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
export declare const GATEWAY_SETTINGS_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly channels: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                        readonly default: true;
                        readonly description: "Start this channel adapter at boot.";
                    };
                    readonly dm: {
                        readonly "x-sigrun-apply": "live";
                        readonly oneOf: readonly [{
                            readonly const: "pairing";
                            readonly title: "Pairing";
                        }, {
                            readonly const: "allowlist";
                            readonly title: "Allowlist";
                        }, {
                            readonly const: "disabled";
                            readonly title: "Disabled";
                        }];
                        readonly default: "pairing";
                        readonly description: "How direct messages are admitted.";
                    };
                    readonly selfLink: {
                        readonly "x-sigrun-apply": "live";
                        readonly type: "boolean";
                        readonly description: "Allow users to link themselves (default: pairing channels only).";
                    };
                    readonly allow: {
                        readonly "x-sigrun-apply": "live";
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly sender: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                    readonly description: "The channel sender id to admit.";
                                };
                                readonly user: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                    readonly description: "The linked sigrun directory user.";
                                };
                            };
                            readonly required: readonly ["sender", "user"];
                            readonly "x-sigrun-key": "sender";
                            readonly "x-sigrun-summary": readonly ["sender", "user"];
                        };
                        readonly default: readonly [];
                        readonly description: "Direct-message allowlist entries.";
                    };
                    readonly groups: {
                        readonly "x-sigrun-apply": "live";
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly chat: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                    readonly description: "The platform group-chat id.";
                                };
                                readonly owner: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                    readonly description: "The directory user whose authority the agent uses.";
                                };
                                readonly mention: {
                                    readonly oneOf: readonly [{
                                        readonly const: "required";
                                        readonly title: "Mention required";
                                    }, {
                                        readonly const: "always";
                                        readonly title: "Always respond";
                                    }];
                                    readonly default: "required";
                                    readonly description: "Whether group messages must mention the agent.";
                                };
                                readonly members: {
                                    readonly oneOf: readonly [{
                                        readonly const: "linked";
                                        readonly title: "Linked users only";
                                    }, {
                                        readonly const: "anyone";
                                        readonly title: "Anyone (requires pinned tools)";
                                    }];
                                    readonly default: "linked";
                                    readonly description: "Who may interact with the agent in this group.";
                                };
                                readonly tools: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                    readonly description: "The group's allowed tool list; required and non-empty for anyone groups.";
                                };
                                readonly extensions: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                    readonly description: "Extensions enabled for this group (anyone groups also include gateway).";
                                };
                            };
                            readonly required: readonly ["chat", "owner"];
                            readonly "x-sigrun-key": "chat";
                            readonly "x-sigrun-summary": readonly ["chat", "owner", "mention"];
                        };
                        readonly default: readonly [];
                        readonly description: "Group chats served by this channel.";
                    };
                    readonly busy: {
                        readonly "x-sigrun-apply": "live";
                        readonly oneOf: readonly [{
                            readonly const: "followUp";
                            readonly title: "Follow up";
                        }, {
                            readonly const: "steer";
                            readonly title: "Steer the current run";
                        }];
                        readonly default: "followUp";
                        readonly description: "How inbound messages behave while the agent is running.";
                    };
                    readonly stream: {
                        readonly "x-sigrun-apply": "live";
                        readonly type: "boolean";
                        readonly default: true;
                        readonly description: "Stream response previews to the chat.";
                    };
                    readonly allowBots: {
                        readonly "x-sigrun-apply": "live";
                        readonly type: "boolean";
                        readonly default: false;
                        readonly description: "Admit messages sent by other bots.";
                    };
                };
                readonly "x-sigrun-summary": readonly ["enabled", "dm", "busy"];
            };
            readonly default: {};
            readonly description: "Channel adapters, keyed by channel id.";
        };
        readonly media: {
            readonly type: "object";
            readonly title: "Media";
            readonly properties: {
                readonly maxBytes: {
                    readonly "x-sigrun-apply": "live";
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly default: 16777216;
                    readonly description: "Maximum size of one inbound attachment in bytes.";
                };
            };
        };
        readonly notify: {
            readonly type: "object";
            readonly title: "Notifications";
            readonly properties: {
                readonly home: {
                    readonly "x-sigrun-apply": "live";
                    readonly type: "boolean";
                    readonly default: true;
                    readonly description: "Deliver notifications to the user's linked home chat.";
                };
            };
        };
    };
};
