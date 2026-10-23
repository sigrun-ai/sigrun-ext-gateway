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
import type { SigrunHost } from "@sigrun/sigrun/extension";
/** The DM admission policy (spec §8.2). */
export type DmPolicy = "pairing" | "allowlist" | "disabled";
/** One group chat's config (spec §8.1). */
export interface GroupConfig {
    readonly chat: string;
    readonly owner: string;
    readonly mention: "required" | "always";
    readonly members: "linked" | "anyone";
    readonly tools?: readonly string[];
    readonly extensions?: readonly string[];
}
/** One channel's config (spec §8.1). */
export interface ChannelConfig {
    readonly enabled: boolean;
    readonly dm: DmPolicy;
    readonly selfLink: boolean;
    readonly allow: readonly {
        sender: string;
        user: string;
    }[];
    readonly groups: readonly (GroupConfig | {
        readonly chat: string;
        readonly failed: string;
    })[];
    readonly busy: "followUp" | "steer";
    readonly stream: boolean;
    readonly allowBots: boolean;
}
/** The whole `settings/gateway.json` shape (spec §8.1). */
export interface GatewayConfig {
    readonly channels: Readonly<Record<string, ChannelConfig | {
        readonly failed: string;
    }>>;
    readonly media: {
        readonly maxBytes: number;
    };
    readonly notify: {
        readonly home: boolean;
    };
}
/** Default media cap (16 MiB — the readFile ceiling, spec §8.1). */
export declare const DEFAULT_MEDIA_MAX_BYTES = 16777216;
/** Parse the raw settings object into the validated {@link GatewayConfig}. */
export declare function parseGatewayConfig(raw: Record<string, unknown>): GatewayConfig;
/**
 * Read the config LIVE through the engine's scoped settings store: the
 * store's object parsed per call, so an operator's edit takes effect on
 * the next event without a restart (only `enabled` is restart-required).
 */
export declare function readConfig(host: SigrunHost): Promise<GatewayConfig>;
