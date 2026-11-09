/**
 * Gateway configuration (spec §8.1): core's checked schema read, plus the
 * cross-field rules JSON Schema cannot express. Core applies every scalar
 * default and repairs malformed stored values; this module retains
 * `selfLink`'s dm-dependent default and the anyone-group rules.
 */
import type { DeclaredSettings, SigrunHost } from "@sigrun/sigrun/extension";
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
export type FailedGroup = {
    readonly chat: string;
    readonly failed: string;
};
/** One channel's config (spec §8.1). */
export interface ChannelConfig {
    readonly enabled: boolean;
    readonly dm: DmPolicy;
    readonly selfLink: boolean;
    readonly allow: readonly {
        sender: string;
        user: string;
    }[];
    readonly groups: readonly (GroupConfig | FailedGroup)[];
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
type Declared = DeclaredSettings<Record<string, unknown>, Record<string, unknown>>;
/** Declare gateway settings ONCE, at the top of the factory. */
export declare function declareSettings(host: SigrunHost): Declared;
/** Apply the gateway's cross-field rules to an already-checked object. */
export declare function resolveGatewayConfig(raw: Record<string, unknown>): GatewayConfig;
/** Read the config LIVE through the factory's declared checked-read handle. */
export declare function readConfig(host: SigrunHost): Promise<GatewayConfig>;
export {};
