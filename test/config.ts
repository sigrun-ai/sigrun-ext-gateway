/** Resolve a raw fixture through core's real schema check and gateway rules. */
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import { resolveGatewayConfig } from "../src/config.js";
import { GATEWAY_SETTINGS_JSON_SCHEMA } from "../src/settings-schema.js";
export type { ChannelConfig, GatewayConfig, GroupConfig } from "../src/config.js";

export function parseGatewayConfig(raw: Record<string, unknown>) {
	return resolveGatewayConfig(checkStoredSettings(GATEWAY_SETTINGS_JSON_SCHEMA, raw).value);
}
