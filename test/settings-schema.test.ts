/**
 * Gateway settings schema (settings rework, Task 13): drawable proof and
 * the old parser's defaults and channel rules on core's checked read.
 */
import { describe, expect, test } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import { GATEWAY_SETTINGS_JSON_SCHEMA } from "../src/settings-schema.js";
import { parseGatewayConfig } from "./config.js";

function checked(settings: Record<string, unknown>): Record<string, unknown> {
	return checkStoredSettings(GATEWAY_SETTINGS_JSON_SCHEMA, settings).value;
}

describe("gateway settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(GATEWAY_SETTINGS_JSON_SCHEMA);
	});

	test("defaults match the old parser", () => {
		expect(parseGatewayConfig(checked({}))).toEqual({
			channels: {},
			media: { maxBytes: 16_777_216 },
			notify: { home: true },
		});
		const channel = parseGatewayConfig(checked({ channels: { loop: {} } })).channels.loop;
		expect(channel).toEqual({
			enabled: true,
			dm: "pairing",
			selfLink: true,
			allow: [],
			groups: [],
			busy: "followUp",
			stream: true,
			allowBots: false,
		});
		const withGroup = parseGatewayConfig(checked({
			channels: { loop: { groups: [{ chat: "-9002", owner: "alice" }] } },
		})).channels.loop;
		if ("failed" in withGroup) throw new Error("loop must parse");
		expect(withGroup.groups).toEqual([{
			chat: "-9002",
			owner: "alice",
			mention: "required",
			members: "linked",
		}]);
	});

	test("an old settings file still loads", () => {
		const config = parseGatewayConfig(checked({
			channels: {
				loop: {
					enabled: false,
					dm: "allowlist",
					selfLink: true,
					allow: [{ sender: "9001", user: "alice" }],
					groups: [{
						chat: "-9003",
						owner: "bob",
						mention: "always",
						members: "anyone",
						tools: ["web_search"],
						extensions: ["memory"],
					}],
					busy: "steer",
					stream: false,
					allowBots: true,
				},
			},
			media: { maxBytes: 1024 },
			notify: { home: false },
		}));
		expect(config).toEqual({
			channels: {
				loop: {
					enabled: false,
					dm: "allowlist",
					selfLink: true,
					allow: [{ sender: "9001", user: "alice" }],
					groups: [{
						chat: "-9003",
						owner: "bob",
						mention: "always",
						members: "anyone",
						tools: ["web_search"],
						extensions: ["memory", "gateway"],
					}],
					busy: "steer",
					stream: false,
					allowBots: true,
				},
			},
			media: { maxBytes: 1024 },
			notify: { home: false },
		});
	});

	test("group entries keep their order", () => {
		const channel = parseGatewayConfig(checked({
			channels: { loop: { groups: [
				{ chat: "-9004", owner: "alice" },
				{ chat: "-9005", owner: "bob", mention: "always" },
				{ chat: "-9006", owner: "carol", tools: ["send_message"] },
			] } },
		})).channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups.map((group) => group.chat)).toEqual(["-9004", "-9005", "-9006"]);
	});

	test("selfLink defaults from dm when absent", () => {
		for (const [dm, selfLink] of [
			["pairing", true],
			["allowlist", false],
			["disabled", false],
		] as const) {
			const channel = parseGatewayConfig(checked({ channels: { loop: { dm } } })).channels.loop;
			expect(channel).toMatchObject({ dm, selfLink });
		}
	});

	test("members anyone without tools disables the group with its reason", () => {
		const channel = parseGatewayConfig(checked({
			channels: { loop: { groups: [
				{ chat: "-9007", owner: "alice", members: "anyone" },
				{ chat: "-9008", owner: "bob" },
			] } },
		})).channels.loop;
		if ("failed" in channel) throw new Error("the channel stays enabled");
		expect(channel.groups).toEqual([
			{ chat: "-9007", failed: 'group "-9007" members: "anyone" requires a non-empty tools array' },
			{ chat: "-9008", owner: "bob", mention: "required", members: "linked" },
		]);
	});

	test("a malformed stored field falls back to its schema default", () => {
		const result = checkStoredSettings(GATEWAY_SETTINGS_JSON_SCHEMA, {
			media: { maxBytes: "big" },
			notify: { home: "yes" },
			channels: { loop: { enabled: "yes" } },
		});
		expect(parseGatewayConfig(result.value)).toMatchObject({
			media: { maxBytes: 16_777_216 },
			notify: { home: true },
			channels: { loop: { enabled: true } },
		});
		expect(result.repairs.map((repair) => repair.path)).toEqual([
			"/channels/loop/enabled",
			"/media/maxBytes",
			"/notify/home",
		]);
	});
});
