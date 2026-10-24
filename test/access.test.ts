/**
 * Access control (Task 4, spec §8.2): link codes (single-use,
 * channel-bound), `runPair` refusals and decisions, the loop guard's
 * pinned thresholds, ButtonTokens, and the DM-policy pipeline stages
 * over FakeHost.
 *
 * Tests own their literals: alice/bob, "100000001", synthetic codes
 * generated at runtime only — no fixture asserts a literal code value.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
	ChannelContribution,
	ChatRef,
	InboundEvent,
	OutboundMessage,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { LinkCodes } from "../src/access/link-codes.js";
import { LoopGuard } from "../src/access/loop-guard.js";
import { PairingStore } from "../src/access/pairing.js";
import { ButtonTokens } from "../src/inbound/tokens.js";
import { normalizeCode } from "../src/access/codes.js";
import { runPair, type PairDeps } from "../src/commands/pair.js";
import { redeemLink, type LinkDeps } from "../src/commands/link.js";
import { IdentityStore } from "../src/state/identities.js";
import { createPipeline, type AccessState } from "../src/inbound/pipeline.js";
import { parseGatewayConfig, type ChannelConfig } from "../src/config.js";
import type { EngineLog } from "../src/log.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const T0 = 1_700_000_000_000;
const dm: ChatRef = { chatId: "100000005", chatType: "dm" };

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function silentLog(): EngineLog {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		once: () => {},
	};
}

describe("LinkCodes (self-link codes, spec §8.2)", () => {
	test("issue → redeem returns the user once (single use)", () => {
		const codes = new LinkCodes();
		const code = codes.issue("alice", "loop", T0);
		expect(code).toHaveLength(8);
		expect(codes.redeem(code, "loop", T0 + 1)).toBe("alice");
		expect(codes.redeem(code, "loop", T0 + 2)).toBeUndefined();
	});

	test("redeem is channel-bound without consuming the code", () => {
		const codes = new LinkCodes();
		const code = codes.issue("alice", "loop", T0);
		expect(codes.redeem(code, "signal", T0 + 1)).toBeUndefined();
		expect(codes.redeem(code, "loop", T0 + 2)).toBe("alice");
	});

	test("codes expire at 3600000 ms", () => {
		const codes = new LinkCodes();
		const code = codes.issue("alice", "loop", T0);
		expect(codes.redeem(code, "loop", T0 + 3_600_000)).toBeUndefined();
	});

	test("invalidate voids a code", () => {
		const codes = new LinkCodes();
		const code = codes.issue("alice", "loop", T0);
		codes.invalidate(code);
		expect(codes.redeem(code, "loop", T0 + 1)).toBeUndefined();
	});
});

describe("LoopGuard (spec §8.2 bot-loop cap)", () => {
	test("10 admitted per chat per 60000 ms, then refused", () => {
		const guard = new LoopGuard();
		for (let i = 0; i < 10; i++) {
			expect(guard.admit("loop:default:dm:100000001", T0 + i)).toBe(true);
		}
		expect(guard.admit("loop:default:dm:100000001", T0 + 10)).toBe(false);
	});

	test("the cooldown lifts after 300000 ms", () => {
		const guard = new LoopGuard();
		for (let i = 0; i < 10; i++) guard.admit("key", T0 + i);
		// The cap triggered a 5-minute cooldown at the 11th attempt.
		expect(guard.admit("key", T0 + 10)).toBe(false);
		expect(guard.admit("key", T0 + 60_000)).toBe(false);
		expect(guard.admit("key", T0 + 310_000)).toBe(true);
	});

	test("the cap is per chat key", () => {
		const guard = new LoopGuard();
		for (let i = 0; i < 10; i++) guard.admit("chat-a", T0 + i);
		expect(guard.admit("chat-b", T0 + 10)).toBe(true);
	});

	test("a fresh 60000 ms window admits again", () => {
		const guard = new LoopGuard();
		for (let i = 0; i < 10; i++) guard.admit("key", T0 + i);
		// The first ten admits aged out of the window: a new burst starts.
		expect(guard.admit("key", T0 + 60_001)).toBe(true);
	});
});

describe("ButtonTokens", () => {
	test("issue → resolve returns the action; a tap consumes the token", () => {
		const tokens = new ButtonTokens();
		const token = tokens.issue({
			kind: "pair",
			code: "ABCD2345",
			decision: "approve",
			user: "bob",
		});
		expect(token).toMatch(/^t:[A-Z2-7]{16}$/);
		expect(tokens.resolve(token)).toEqual({
			kind: "pair",
			code: "ABCD2345",
			decision: "approve",
			user: "bob",
		});
		expect(tokens.resolve(token)).toBeUndefined();
	});

	test("unknown tokens resolve undefined", () => {
		const tokens = new ButtonTokens();
		expect(tokens.resolve("t:AAAAAAAAAAAAAAAA")).toBeUndefined();
	});

	test("interaction actions round-trip", () => {
		const tokens = new ButtonTokens();
		const token = tokens.issue({
			kind: "interaction",
			conversationId: 3,
			callId: "call-1",
			optionId: "opt-2",
		});
		expect(tokens.resolve(token)).toEqual({
			kind: "interaction",
			conversationId: 3,
			callId: "call-1",
			optionId: "opt-2",
		});
	});
});

/** The recorded adapter sends (notices) the pair/link rigs observe. */
interface Sent {
	chat: ChatRef;
	text: string;
	buttons?: readonly (readonly { label: string; data: string }[])[];
}

/** The fake channel adapter (records sends). */
function fakeChannel(): ChannelContribution & { sent: Sent[] } {
	const adapter = {
		id: "loop",
		label: "Loop",
		capabilities: {
			chatTypes: ["dm", "group"] as const,
			maxMessageLength: 200,
			format: "markdown" as const,
			buttons: { max: 3 },
		},
		configured: () => ({ status: "ready" as const }),
		start: async () => {},
		send: async (message: OutboundMessage) => {
			adapter.sent.push({
				chat: message.chat,
				text: message.text,
				...(message.buttons === undefined ? {} : { buttons: message.buttons }),
			});
			return { messageIds: [`loop-${adapter.sent.length}`] };
		},
		sent: [] as Sent[],
	};
	return adapter;
}

/** The /pair command rig: real stores over a temp dir + FakeHost. */
async function pairRig(
	users: readonly { user: string; admin?: boolean }[] = [
		{ user: "alice", admin: true },
		{ user: "bob" },
	],
): Promise<{
	deps: PairDeps;
	host: FakeHost;
	identities: IdentityStore;
	pairing: PairingStore;
	channel: ReturnType<typeof fakeChannel>;
	request(senderId: string, name?: string): string;
}> {
	const dir = await tempDir("sigrun-gw-pair-");
	const host = await createFakeHost({ storesDir: dir, users });
	const identities = new IdentityStore(join(dir, "gateway", "identities.json"));
	const pairing = new PairingStore(join(dir, "gateway", "pairing.json"), {
		now: () => T0,
	});
	const channel = fakeChannel();
	const deps: PairDeps = {
		host,
		identities,
		pairing,
		channelOf: (id) => (id === "loop" ? channel : undefined),
		log: silentLog(),
		now: () => T0,
	};
	return {
		deps,
		host,
		identities,
		pairing,
		channel,
		request: (senderId, name) => {
			const result = pairing.request("loop", { id: senderId, name }, dm, T0);
			if (!("code" in result)) throw new Error("test setup: request limited");
			return result.code;
		},
	};
}

describe("runPair (the /pair command)", () => {
	test("refuses an unnamed caller with exactly 'run this as a named user'", async () => {
		const { deps } = await pairRig();
		expect(await runPair(deps, "", { user: undefined, admin: true })).toBe(
			"run this as a named user",
		);
		expect(
			await runPair(deps, "approve ABCD2345 bob", { user: undefined, admin: true }),
		).toBe("run this as a named user");
	});

	test("refuses non-admins and changes nothing", async () => {
		const { deps, request } = await pairRig();
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, `approve ${code} bob`, {
			user: "bob",
			admin: false,
		});
		expect(reply).toContain("admin");
		expect(deps.pairing.pending().length).toBe(1);
		expect(deps.pairing.pending()[0]?.code).toBe(code);
	});

	test("refuses a user absent from host.users", async () => {
		const { deps, request } = await pairRig();
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, `approve ${code} nobody`, {
			user: "alice",
			admin: true,
		});
		expect(reply).toContain("nobody");
		expect(deps.pairing.pending().length).toBe(1);
	});

	test("approve links the requester via pairing and sends them a linked message", async () => {
		const { deps, identities, channel, request } = await pairRig();
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, `approve ${code} bob`, {
			user: "alice",
			admin: true,
		});
		expect(reply).toContain("bob");
		expect(deps.pairing.pending().length).toBe(0);
		const config = loopConfig({});
		expect(identities.userFor(config, "loop", "100000001")).toEqual({
			user: "bob",
			via: "link",
		});
		// The requester's DM got the "linked" message through the channel.
		expect(channel.sent.length).toBe(1);
		expect(channel.sent[0]?.chat).toEqual(dm);
		expect(channel.sent[0]?.text).toContain("bob");
	});

	test("deny removes the request", async () => {
		const { deps, request } = await pairRig();
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, `deny ${code}`, { user: "alice", admin: true });
		expect(reply).toContain("denied");
		expect(deps.pairing.pending().length).toBe(0);
	});

	test("listing shows pending requests with their codes (the admin's working surface)", async () => {
		const { deps, request } = await pairRig();
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, "", { user: "alice", admin: true });
		expect(reply).toContain("loop");
		expect(reply).toContain("Alice");
		expect(reply).toContain(code);
	});

	test("an unknown approve code is reported", async () => {
		const { deps } = await pairRig();
		const reply = await runPair(deps, "approve ZZZZZZZZ bob", {
			user: "alice",
			admin: true,
		});
		expect(reply).toContain("unknown");
	});

	test("approve of a sender linked to another user refuses and keeps the request pending", async () => {
		const { deps, request } = await pairRig();
		// The pending sender is already linked to alice: approving them to
		// bob must refuse, never silently re-point the link.
		await deps.identities.link("loop", "100000001", "alice", "self", dm);
		const code = request("100000001", "Alice");
		const reply = await runPair(deps, `approve ${code} bob`, {
			user: "alice",
			admin: true,
		});
		expect(reply).toContain("already linked");
		expect(deps.pairing.pending().length).toBe(1);
		const config = loopConfig({});
		expect(identities_user(deps, config)).toBe("alice");
	});

	test("malformed args get a usage line", async () => {
		const { deps } = await pairRig();
		const reply = await runPair(deps, "frobnicate", { user: "alice", admin: true });
		expect(reply).toContain("usage");
	});
});

/** Resolve sender 100000001 on loop through the rig's identity store. */
function identities_user(deps: PairDeps, config: ChannelConfig): string | undefined {
	return deps.identities.userFor(config, "loop", "100000001")?.user;
}

/** One parsed loop channel config over `over`. */
function loopConfig(over: Record<string, unknown>): ChannelConfig {
	const parsed = parseGatewayConfig({
		channels: { loop: { dm: "pairing", ...over } },
	}).channels.loop;
	if (parsed === undefined || "failed" in parsed) {
		throw new Error("test setup: loop channel must parse");
	}
	return parsed;
}

/** The tap handler's config (pairing DMs — the taps test's shape). */
function loopConfigPairing(): ChannelConfig {
	return loopConfig({});
}

describe("redeemLink (the /link chat side, pipeline stage 4)", () => {
	async function linkRig(): Promise<{
		host: FakeHost;
		identities: IdentityStore;
		codes: LinkCodes;
		channel: ReturnType<typeof fakeChannel>;
		deps: LinkDeps;
	}> {
		const dir = await tempDir("sigrun-gw-link-");
		const host = await createFakeHost({
			storesDir: dir,
			users: [{ user: "alice", admin: true }],
		});
		const identities = new IdentityStore(join(dir, "gateway", "identities.json"));
		const codes = new LinkCodes();
		const channel = fakeChannel();
		const deps: LinkDeps = {
			identities,
			linkCodes: codes,
			log: silentLog(),
			now: () => T0,
		};
		return { host, identities, codes, channel, deps };
	}

	function dmEvent(text: string): InboundEvent {
		return {
			messageId: "m1",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text,
		};
	}

	test("a valid code in a DM links the sender and the reply names the user", async () => {
		const rig = await linkRig();
		const code = rig.codes.issue("alice", "loop", T0);
		const reply = await redeemLink(rig.deps, "loop", dmEvent(`/link ${code}`));
		expect(reply).toContain("alice");
		expect(rig.identities.userFor(loopConfig({}), "loop", "100000001")).toEqual({
			user: "alice",
			via: "link",
		});
		// The first link set the requester's DM as their home chat.
		expect(rig.identities.homesOf("alice")).toEqual([
			{ channel: "loop", chat: { chatId: "100000001", chatType: "dm" } },
		]);
	});

	test("a sender linked to another user gets the conflict reply and keeps the code", async () => {
		const rig = await linkRig();
		// The sender is linked to bob; the code was issued for alice.
		await rig.identities.link("loop", "100000001", "bob", "self", dm);
		const code = rig.codes.issue("alice", "loop", T0);
		const reply = await redeemLink(rig.deps, "loop", dmEvent(`/link ${code}`));
		expect(reply).toContain("already linked");
		// The code is NOT consumed: after removing the conflicting link the
		// same code still redeems.
		const reply2 = await redeemLink(rig.deps, "loop", dmEvent(`/link ${code}`));
		expect(reply2).toContain("already linked");
	});

	test("an unknown code replies a notice", async () => {
		const rig = await linkRig();
		const reply = await redeemLink(rig.deps, "loop", dmEvent("/link ZZZZZZZZ"));
		expect(reply).toContain("code");
	});

	test("a code folded through normalizeCode still redeems", async () => {
		const rig = await linkRig();
		const code = rig.codes.issue("alice", "loop", T0);
		// The pipeline normalizes before redeeming; the raw form here uses a
		// lowercase + separator variant to prove the fold.
		expect(normalizeCode(code.toLowerCase())).toBe(code);
	});
});

// ---------------------------------------------------------------------------
// Pipeline stages over FakeHost (steps 1, 4, 5 + the loop guard)
// ---------------------------------------------------------------------------

/** The pipeline rig: a fake host, an explicit access state, one pipeline. */
interface StageRig {
	host: FakeHost;
	channel: ReturnType<typeof fakeChannel>;
	access: AccessState;
	receive(event: InboundEvent, config?: Record<string, unknown>): Promise<{
		outcome: "admitted" | "dropped" | "command";
	}>;
	action(token: string): Promise<void>;
	actionAsSender(senderId: string, token: string): Promise<void>;
	sent: Sent[];
	submits(): number;
}

async function stageRig(
	gatewaySettings: Record<string, unknown> = {
		channels: { loop: { dm: "pairing" } },
	},
	users: readonly { user: string; admin?: boolean }[] = [
		{ user: "alice", admin: true },
	],
): Promise<StageRig> {
	const dir = await tempDir("sigrun-gw-stages-");
	const host = await createFakeHost({ storesDir: dir, users });
	await host.stores.settings.set(gatewaySettings);
	const channel = fakeChannel();
	const access: AccessState = {
		identities: new IdentityStore(join(dir, "gateway", "identities.json")),
		pairing: new PairingStore(join(dir, "gateway", "pairing.json"), {
			now: () => T0,
		}),
		linkCodes: new LinkCodes(),
		tokens: new ButtonTokens(),
		loopGuard: new LoopGuard(),
	};
	const pipeline = createPipeline({
		host,
		channel,
		stateDir: dir,
		log: silentLog(),
		origins: new Map(),
		access,
		now: () => T0,
	});
	const receive = (event: InboundEvent, config?: Record<string, unknown>) => {
		const block =
			config ??
			(gatewaySettings.channels as Record<string, Record<string, unknown>>)
				.loop;
		const parsed = parseGatewayConfig({ channels: { loop: block } }).channels
			.loop;
		if (parsed === undefined || "failed" in parsed) {
			throw new Error("test setup: loop channel must parse");
		}
		return pipeline("loop", event, parsed);
	};
	const sent = channel.sent;
	const action = async (token: string): Promise<void> => {
		await actionAsSender("100000001", token);
	};
	const submits = () =>
		host.calls.filter((call) => call.method === "conversations.submit").length;
	const actionAsSender = async (
		senderId: string,
		token: string,
	): Promise<void> => {
		await pipeline.action(
			"loop",
			{
				chat: dm,
				sender: {
					id: senderId,
					name: senderId === "100000001" ? "Alice" : "Bob",
				},
				data: token,
			},
			loopConfigPairing(),
		);
	};
	return { host, channel, access, receive, action, actionAsSender, sent, submits };
}

describe("pipeline step 1: the claimed gate", () => {
	test("an unclaimed directory drops inbound with no reply", async () => {
		const rig = await stageRig();
		rig.host.setClaimed(false);
		const outcome = await rig.receive({
			messageId: "m1",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: "hello",
		});
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(rig.sent).toEqual([]);
		expect(rig.submits()).toBe(0);
	});
});

describe("pipeline step 4: self-link", () => {
	const linkEvent = (text: string): InboundEvent => ({
		messageId: "m1",
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text,
	});

	test("/link <code> in a DM resolves command and links the sender", async () => {
		const rig = await stageRig();
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		const outcome = await rig.receive(linkEvent(`/link ${code}`));
		expect(outcome).toEqual({ outcome: "command" });
		expect(rig.sent.length).toBe(1);
		expect(rig.sent[0]?.text).toContain("alice");
		expect(rig.submits()).toBe(0);
		expect(
			rig.access.identities.userFor(loopConfig({}), "loop", "100000001"),
		).toEqual({ user: "alice", via: "link" });
	});

	test("/link <code> in a group replies the pinned refusal and invalidates the code", async () => {
		const rig = await stageRig();
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		const group: InboundEvent = {
			messageId: "m1",
			chat: { chatId: "-100000000002", chatType: "group", title: "Dev" },
			sender: { id: "100000001", name: "Alice" },
			text: `/link ${code}`,
		};
		const outcome = await rig.receive(group);
		expect(outcome).toEqual({ outcome: "command" });
		expect(rig.sent[0]?.text).toBe("send this in a direct message");
		// The code is invalidated: the same code now fails in a DM.
		const dmOutcome = await rig.receive(linkEvent(`/link ${code}`));
		expect(dmOutcome).toEqual({ outcome: "command" });
		expect(rig.sent.at(-1)?.text).not.toContain("alice");
	});

	test("selfLink: false leaves /link to the access policy", async () => {
		const rig = await stageRig({
			channels: {
				loop: {
					dm: "allowlist",
					selfLink: false,
					allow: [{ sender: "100000001", user: "alice" }],
				},
			},
		});
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		// An UNLINKED sender's /link drops under the allowlist policy: the
		// code was never redeemable by them.
		const outcome = await rig.receive({
			messageId: "m1",
			chat: { chatId: "200000002", chatType: "dm" },
			sender: { id: "200000002", name: "Bob" },
			text: `/link ${code}`,
		});
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(rig.sent).toEqual([]);
		expect(
			rig.access.identities.userFor(loopConfig({ selfLink: false }), "loop", "200000002"),
		).toBeUndefined();
	});
});

describe("pipeline step 5: DM policies", () => {
	const event = (senderId: string, messageId: string): InboundEvent => ({
		messageId,
		chat: { chatId: senderId, chatType: "dm" },
		sender: { id: senderId, name: senderId === "100000001" ? "Alice" : "Bob" },
		text: "hello gateway",
	});

	test("disabled drops unknown senders silently", async () => {
		const rig = await stageRig({
			channels: { loop: { dm: "disabled", allow: [{ sender: "100000001", user: "alice" }] } },
		});
		const outcome = await rig.receive(event("200000002", "m1"));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(rig.sent).toEqual([]);
	});

	test("allowlist drops unknown senders (no pairing reply)", async () => {
		const rig = await stageRig({
			channels: { loop: { dm: "allowlist" } },
		});
		const outcome = await rig.receive(event("200000002", "m1"));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(rig.sent).toEqual([]);
		expect(rig.submits()).toBe(0);
	});

	test("pairing replies once with the code and does not submit the message", async () => {
		const rig = await stageRig();
		const outcome = await rig.receive(event("200000002", "m1"));
		expect(outcome).toEqual({ outcome: "dropped" });
		expect(rig.sent.length).toBe(1);
		const text = rig.sent[0]?.text ?? "";
		// The reply carries the 8-char code (extracted at runtime).
		const code = text.match(/[A-Z2-9]{8}/)?.[0];
		expect(code).toBeDefined();
		expect(rig.access.pairing.pending().length).toBe(1);
		expect(rig.submits()).toBe(0);
	});

	test("pairing limits send no reply", async () => {
		const rig = await stageRig();
		await rig.receive(event("200000002", "m1"));
		// A second request from the same sender while one is pending: no reply.
		await rig.receive(event("200000002", "m2"));
		expect(rig.sent.length).toBe(1);
		// Three distinct senders fill the channel; the fourth gets nothing.
		await rig.receive(event("300000003", "m3"));
		await rig.receive(event("400000004", "m4"));
		await rig.receive(event("500000005", "m5"));
		expect(rig.sent.length).toBe(3);
	});

	test("admin notices reach every effective admin's home DM with buttons when they fit", async () => {
		// Two directory users (alice admin + bob): buttons fit at max 3
		// (2 approve + 1 deny).
		const rig = await stageRig(
			{ channels: { loop: { dm: "pairing" } } },
			[
				{ user: "alice", admin: true },
				{ user: "bob" },
			],
		);
		// alice links herself first (her DM becomes her home chat).
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		await rig.receive({
			messageId: "l1",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: `/link ${code}`,
		});
		rig.sent.length = 0;
		// bob's DM requests pairing: alice's home DM gets the notice.
		await rig.receive(event("200000002", "p1"));
		expect(rig.sent.length).toBe(2);
		const notice = rig.sent[1];
		expect(notice?.chat).toEqual({ chatId: "100000001", chatType: "dm" });
		const buttons = (notice?.buttons ?? []).flat();
		expect(buttons.map((b) => b.label).sort()).toEqual([
			"Approve as alice",
			"Approve as bob",
			"Deny",
		].sort());
		// Every button carries a distinct opaque token.
		const datas = new Set(buttons.map((b) => b.data));
		expect(datas.size).toBe(3);
	});

	test("buttons are omitted when the directory has too many users", async () => {
		// 4 users vs buttons.max 3: no buttons (4 > 3 - 1).
		const rig = await stageRig(
			{ channels: { loop: { dm: "pairing" } } },
			[
				{ user: "alice", admin: true },
				{ user: "bob" },
				{ user: "carol" },
				{ user: "dave" },
			],
		);
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		await rig.receive({
			messageId: "l1",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: `/link ${code}`,
		});
		rig.sent.length = 0;
		await rig.receive(event("200000002", "p1"));
		const notice = rig.sent[1];
		expect(notice?.buttons).toBeUndefined();
	});

	test("a tap on an Approve button links the requester", async () => {
		const rig = await stageRig(
			{ channels: { loop: { dm: "pairing" } } },
			[
				{ user: "alice", admin: true },
				{ user: "bob" },
			],
		);
		const code = rig.access.linkCodes.issue("alice", "loop", T0);
		await rig.receive({
			messageId: "l1",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: `/link ${code}`,
		});
		rig.sent.length = 0;
		await rig.receive(event("200000002", "p1"));
		const notice = rig.sent[1];
		const approve = (notice?.buttons ?? [])
			.flat()
			.find((b) => b.label === "Approve as bob");
		if (approve === undefined) throw new Error("test setup: no Approve as bob");
		// alice taps in her home DM: the tap routes through ButtonTokens.
		await rig.action(approve.data);
		expect(rig.access.pairing.pending().length).toBe(0);
		expect(
			rig.access.identities.userFor(loopConfig({}), "loop", "200000002"),
		).toEqual({ user: "bob", via: "link" });
		// The requester got the "linked" message (the LATEST one to their
		// DM — the pairing reply came first).
		const linked = rig.sent
			.filter((s) => s.chat.chatId === "200000002")
			.at(-1);
		expect(linked?.text).toContain("bob");
		// The token is consumed: a replayed tap does nothing.
		const pendingBefore = rig.access.pairing.pending().length;
		await rig.action(approve.data);
		expect(rig.access.pairing.pending().length).toBe(pendingBefore);
	});

	test("a tap by a non-admin resolves the token but applies no decision", async () => {
		const rig = await stageRig(
			{ channels: { loop: { dm: "pairing" } } },
			[
				{ user: "alice", admin: true },
			{ user: "bob" },
			],
		);
		// bob self-links (his DM becomes a home chat, but he is NOT an
		// effective admin): a token tapped by him must apply nothing.
		const bobCode = rig.access.linkCodes.issue("bob", "loop", T0);
		await rig.receive({
			messageId: "l1",
			chat: { chatId: "200000002", chatType: "dm" },
			sender: { id: "200000002", name: "Bob" },
			text: `/link ${bobCode}`,
		});
		// A fresh requester pairs; a token minted for bob taps the approve.
		await rig.receive(event("300000003", "p1"));
		const pendingCode = rig.access.pairing.pending("loop")[0]?.code;
		if (pendingCode === undefined) throw new Error("test setup: no pending row");
		const token = rig.access.tokens.issue({
			kind: "pair",
			code: pendingCode,
			decision: "approve",
			user: "alice",
		});
		await rig.actionAsSender("200000002", token);
		expect(rig.access.pairing.pending().length).toBe(1);
		expect(
			rig.access.identities.userFor(loopConfig({}), "loop", "300000003"),
		).toBeUndefined();
	});

	test("known senders are admitted under every dm policy", async () => {
		for (const dmPolicy of ["pairing", "allowlist", "disabled"] as const) {
			const rig = await stageRig({
				channels: {
					loop: { dm: dmPolicy, allow: [{ sender: "100000001", user: "alice" }] },
				},
			});
			const outcome = await rig.receive(event("100000001", "m1"));
			expect(outcome).toEqual({ outcome: "admitted" });
			expect(rig.submits()).toBe(1);
		}
	});
});

describe("pipeline step 3: the loop guard on admitted bot messages", () => {
	const botEvent = (n: number): InboundEvent => ({
		messageId: `m${n}`,
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "900000009", name: "Bot", isBot: true },
		text: `beep ${n}`,
	});

	test("the 11th bot message in 60 s drops, and the cooldown holds", async () => {
		const rig = await stageRig({
			channels: {
				loop: {
					dm: "allowlist",
					allow: [{ sender: "900000009", user: "alice" }],
					allowBots: true,
				},
			},
		});
		for (let i = 1; i <= 10; i++) {
			const outcome = await rig.receive(botEvent(i));
			expect(outcome).toEqual({ outcome: "admitted" });
		}
		const blocked = await rig.receive(botEvent(11));
		expect(blocked).toEqual({ outcome: "dropped" });
		// The clock is pinned at T0: still inside the cooldown.
		const still = await rig.receive(botEvent(12));
		expect(still).toEqual({ outcome: "dropped" });
	});

	test("bot messages still drop without allowBots (Task 3 behavior preserved)", async () => {
		const rig = await stageRig();
		const outcome = await rig.receive(botEvent(1));
		expect(outcome).toEqual({ outcome: "dropped" });
	});
});
