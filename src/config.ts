/**
 * Gateway configuration (spec §8.1): core's checked schema read, plus the
 * cross-field rules JSON Schema cannot express. Core applies every scalar
 * default and repairs malformed stored values; this module retains
 * `selfLink`'s dm-dependent default and the anyone-group rules.
 */

import type { DeclaredSettings, SigrunHost } from "@sigrun/sigrun/extension";
import { GATEWAY_SETTINGS_JSON_SCHEMA } from "./settings-schema.js";

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

export type FailedGroup = { readonly chat: string; readonly failed: string };

/** One channel's config (spec §8.1). */
export interface ChannelConfig {
	readonly enabled: boolean;
	readonly dm: DmPolicy;
	readonly selfLink: boolean;
	readonly allow: readonly { sender: string; user: string }[];
	readonly groups: readonly (GroupConfig | FailedGroup)[];
	readonly busy: "followUp" | "steer";
	readonly stream: boolean;
	readonly allowBots: boolean;
}

/** The whole `settings/gateway.json` shape (spec §8.1). */
export interface GatewayConfig {
	readonly channels: Readonly<Record<string, ChannelConfig | { readonly failed: string }>>;
	readonly media: { readonly maxBytes: number };
	readonly notify: { readonly home: boolean };
}

/** Default media cap (16 MiB — the readFile ceiling, spec §8.1). */
export const DEFAULT_MEDIA_MAX_BYTES = 16_777_216;

type Declared = DeclaredSettings<Record<string, unknown>, Record<string, unknown>>;
const declaredByHost = new WeakMap<SigrunHost, Declared>();

/** Declare gateway settings ONCE, at the top of the factory. */
export function declareSettings(host: SigrunHost): Declared {
	const declared = host.settings.declare({ schema: GATEWAY_SETTINGS_JSON_SCHEMA });
	declaredByHost.set(host, declared);
	return declared;
}

/** Apply the gateway's cross-field rules to an already-checked object. */
export function resolveGatewayConfig(raw: Record<string, unknown>): GatewayConfig {
	const channels: Record<string, ChannelConfig | { readonly failed: string }> = {};
	if (isRecord(raw.channels)) {
		for (const [id, block] of Object.entries(raw.channels)) {
			channels[id] = typeof (block as Record<string, unknown>).failed === "string"
				? { failed: (block as Record<string, unknown>).failed as string }
				: resolveChannel(block as Record<string, unknown>);
		}
	}
	const media = isRecord(raw.media) && typeof raw.media.maxBytes === "number"
		? raw.media.maxBytes
		: DEFAULT_MEDIA_MAX_BYTES;
	const home = isRecord(raw.notify) && typeof raw.notify.home === "boolean" ? raw.notify.home : true;
	return { channels, media: { maxBytes: media }, notify: { home } };
}

/** Read the config LIVE through the factory's declared checked-read handle. */
export async function readConfig(host: SigrunHost): Promise<GatewayConfig> {
	const declared = declaredByHost.get(host);
	if (declared === undefined) throw new Error("readConfig before the factory declared settings");
	return resolveGatewayConfig(await declared.get());
}

function resolveChannel(value: Record<string, unknown>): ChannelConfig {
	const dm = value.dm as DmPolicy;
	return {
		enabled: value.enabled as boolean,
		dm,
		selfLink: value.selfLink === undefined ? dm === "pairing" : value.selfLink as boolean,
		allow: value.allow as ChannelConfig["allow"],
		groups: (value.groups as readonly Record<string, unknown>[]).map(resolveGroup),
		busy: value.busy as ChannelConfig["busy"],
		stream: value.stream as boolean,
		allowBots: value.allowBots as boolean,
	};
}

function resolveGroup(value: Record<string, unknown>): GroupConfig | FailedGroup {
	const chat = value.chat as string;
	const members = value.members as GroupConfig["members"];
	const tools = value.tools as readonly string[] | undefined;
	let extensions = value.extensions as readonly string[] | undefined;
	if (members === "anyone") {
		// An open group without a pinned tool set would run the full default
		// agent for untrusted senders (spec §8.1). Only this GROUP fails.
		if (tools === undefined || tools.length === 0) {
			return { chat, failed: `group "${chat}" members: "anyone" requires a non-empty tools array` };
		}
		// The gateway's own prompt section rides along on anyone groups (§8.10).
		if (extensions !== undefined && !extensions.includes("gateway")) extensions = [...extensions, "gateway"];
	}
	return {
		chat,
		owner: value.owner as string,
		mention: value.mention as GroupConfig["mention"],
		members,
		...(tools === undefined ? {} : { tools }),
		...(extensions === undefined ? {} : { extensions }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
