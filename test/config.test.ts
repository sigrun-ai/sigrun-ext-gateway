/**
 * GatewayConfig parsing (spec §8.1): the defaults table, the
 * `members: "anyone"` tools requirement, the `gateway` self-append for
 * `anyone` groups' `extensions` (§8.10), and per-channel malformed
 * isolation (a failed channel never fails its siblings).
 *
 * Tests own their literals: synthetic senders/users, no real ids.
 */

import { describe, expect, test } from "vitest";
import { parseGatewayConfig } from "../src/config.js";

describe("parseGatewayConfig", () => {
	test("an empty object yields every default", () => {
		expect(parseGatewayConfig({})).toEqual({
			channels: {},
			media: { maxBytes: 16_777_216 },
			notify: { home: true },
		});
	});

	test("an absent channel is not present (disabled by absence)", () => {
		const config = parseGatewayConfig({});
		expect("telegram" in config.channels).toBe(false);
	});

	test("channel defaults: enabled, pairing dm, selfLink follows dm, empty allow/groups, followUp busy, stream on, bots off", () => {
		const config = parseGatewayConfig({
			channels: { loop: {} },
		});
		expect(config.channels.loop).toEqual({
			enabled: true,
			dm: "pairing",
			selfLink: true,
			allow: [],
			groups: [],
			busy: "followUp",
			stream: true,
			allowBots: false,
		});
	});

	test("an allowlist channel defaults selfLink to false (a closed list by operator choice)", () => {
		const config = parseGatewayConfig({
			channels: { loop: { dm: "allowlist" } },
		});
		expect(config.channels.loop).toMatchObject({
			dm: "allowlist",
			selfLink: false,
		});
	});

	test("an explicit selfLink survives either dm policy", () => {
		const config = parseGatewayConfig({
			channels: {
				a: { dm: "allowlist", selfLink: true },
				b: { dm: "pairing", selfLink: false },
			},
		});
		expect(config.channels.a).toMatchObject({ selfLink: true });
		expect(config.channels.b).toMatchObject({ selfLink: false });
	});

	test("an explicit dm disabled channel keeps pairing's selfLink default (false-when-not-pairing)", () => {
		const config = parseGatewayConfig({
			channels: { loop: { dm: "disabled" } },
		});
		expect(config.channels.loop).toMatchObject({
			dm: "disabled",
			selfLink: false,
		});
	});

	test("an enabled:false channel parses with enabled false", () => {
		const config = parseGatewayConfig({
			channels: { loop: { enabled: false } },
		});
		expect(config.channels.loop).toMatchObject({ enabled: false });
	});

	test("allow entries and groups parse verbatim; group defaults mention required + linked", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					allow: [{ sender: "9001", user: "alice" }],
					groups: [
						{ chat: "-9002", owner: "alice" },
						{
							chat: "-9003",
							owner: "bob",
							mention: "always",
							members: "linked",
							tools: ["web_search"],
						},
					],
				},
			},
		});
		const channel = config.channels.loop;
		expect(channel).toMatchObject({
			allow: [{ sender: "9001", user: "alice" }],
		});
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups).toEqual([
			{
				chat: "-9002",
				owner: "alice",
				mention: "required",
				members: "linked",
			},
			{
				chat: "-9003",
				owner: "bob",
				mention: "always",
				members: "linked",
				tools: ["web_search"],
			},
		]);
	});

	test("an anyone group without tools is {chat, failed}", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{ chat: "-9004", owner: "alice", members: "anyone" },
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups).toEqual([
			{ chat: "-9004", failed: expect.any(String) },
		]);
	});

	test("an anyone group with an empty tools array is {chat, failed}", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{ chat: "-9005", owner: "alice", members: "anyone", tools: [] },
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups).toEqual([
			{ chat: "-9005", failed: expect.any(String) },
		]);
	});

	test("extensions on an anyone group gains \"gateway\" appended when absent (spec §8.10)", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{
							chat: "-9006",
							owner: "alice",
							members: "anyone",
							tools: ["web_search"],
							extensions: ["memory"],
						},
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups[0]).toMatchObject({
			extensions: ["memory", "gateway"],
		});
	});

	test("extensions on an anyone group that already lists gateway is unchanged", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{
							chat: "-9007",
							owner: "alice",
							members: "anyone",
							tools: ["web_search"],
							extensions: ["memory", "gateway"],
						},
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups[0]).toMatchObject({
			extensions: ["memory", "gateway"],
		});
	});

	test("extensions on a linked group is verbatim (no self-append outside anyone groups)", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{
							chat: "-9008",
							owner: "alice",
							members: "linked",
							extensions: ["memory"],
						},
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups[0]).toMatchObject({
			extensions: ["memory"],
		});
	});

	test("a malformed channel block is {failed} while a sibling parses", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: { dm: "nope" },
				other: { dm: "allowlist" },
			},
		});
		expect(config.channels.loop).toEqual({
			failed: expect.any(String),
		});
		expect(config.channels.other).toMatchObject({ dm: "allowlist" });
	});

	test("a non-object channel block is {failed}", () => {
		const config = parseGatewayConfig({
			channels: { loop: "telegram, obviously" },
		});
		expect(config.channels.loop).toEqual({
			failed: expect.any(String),
		});
	});

	test("a malformed group is {chat, failed} while a sibling group parses", () => {
		const config = parseGatewayConfig({
			channels: {
				loop: {
					groups: [
						{ chat: "-9010", owner: "alice", mention: "sometimes" },
						{ chat: "-9011", owner: "bob" },
					],
				},
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups[0]).toEqual({
			chat: "-9010",
			failed: expect.any(String),
		});
		expect(channel.groups[1]).toMatchObject({ owner: "bob" });
	});

	test("a group block without a chat is {chat: \"\", failed}", () => {
		// The failed-group form still names WHICH chat failed — an absent
		// chat renders as the empty string so the row is shaped.
		const config = parseGatewayConfig({
			channels: {
				loop: { groups: [{ owner: "alice" }] },
			},
		});
		const channel = config.channels.loop;
		if ("failed" in channel) throw new Error("loop must parse");
		expect(channel.groups[0]).toEqual({
			chat: "",
			failed: expect.any(String),
		});
	});

	test("media.maxBytes and notify.home override defaults", () => {
		const config = parseGatewayConfig({
			media: { maxBytes: 1024 },
			notify: { home: false },
		});
		expect(config.media).toEqual({ maxBytes: 1024 });
		expect(config.notify).toEqual({ home: false });
	});

	test("malformed media/notify values fall back to defaults (whole-config resilience)", () => {
		const config = parseGatewayConfig({
			media: { maxBytes: "big" },
			notify: { home: "yes" },
		});
		expect(config.media).toEqual({ maxBytes: 16_777_216 });
		expect(config.notify).toEqual({ home: true });
	});

	test("a non-object channels key is ignored (empty channels)", () => {
		const config = parseGatewayConfig({ channels: "no" });
		expect(config.channels).toEqual({});
	});
});
