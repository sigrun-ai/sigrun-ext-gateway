/**
 * Chat interaction planning, prompts, answering and settlement (Task 9).
 * Trees are literal JSON in the fixture-gate shape; users and platform ids
 * are synthetic (alice/bob, "100000001").
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BLOCK_SET_VERSION, type Tree } from "@sigrun/shared/blocks";
import type { InteractionRecord } from "@sigrun/shared/interactions";
import type {
	ActionEvent,
	ChannelCapabilities,
	ChannelContribution,
	HandlerContext,
	InboundEvent,
	MessageRef,
	OutboundMessage,
} from "@sigrun/sigrun/extension";
import {
	planInteraction,
	renderInteraction,
} from "../src/interactions/render.js";
import { PromptStore } from "../src/interactions/prompts.js";
import {
	answerFromChat,
	createInteractionAnswerStage,
} from "../src/interactions/answer.js";
import {
	createInteractionNotifier,
	onInteractionSettled,
} from "../src/interactions/chat.js";
import { DeliveryWorker } from "../src/outbound/delivery.js";
import { createPipeline } from "../src/inbound/pipeline.js";
import { bindingKey, BindingStore } from "../src/state/bindings.js";
import { IdentityStore } from "../src/state/identities.js";
import { Ledger } from "../src/state/ledger.js";
import { ButtonTokens } from "../src/inbound/tokens.js";
import { createFakeHost } from "./fake-host.js";
import { parseGatewayConfig, type ChannelConfig } from "../src/config.js";
import type { EngineLog } from "../src/log.js";

const LOG: EngineLog = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	once: () => {},
};

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function caps(over: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
	return {
		chatTypes: ["dm", "group", "thread"],
		maxMessageLength: 4000,
		format: "markdown",
		buttons: { max: 3, labelMax: 12 },
		edit: { minIntervalMs: 10 },
		...over,
	};
}

function record(body: Tree | undefined, over: Partial<InteractionRecord> = {}): InteractionRecord {
	return {
		kind: "gate.ask",
		callId: "call-1",
		status: "pending",
		createdAt: 1,
		...(body === undefined ? {} : { body }),
		...over,
	};
}

function form(children: Tree["root"] extends { type: "form" } ? never : readonly unknown[]): Tree {
	return {
		v: BLOCK_SET_VERSION,
		root: { type: "form", bind: "/values", mode: "submit", children },
	} as Tree;
}

const GATE = form([
	{
		type: "choice",
		name: "decision",
		label: "Allow the gated tool call?",
		options: [
			{ id: "allow", label: "Allow", tone: "good" },
			{ id: "deny", label: "Deny", tone: "bad" },
		],
	},
	{ type: "longtext", name: "reason", label: "Reason" },
]);

describe("planInteraction", () => {
	test("fixture-gate decision + optional reason plans choice on decision", () => {
		expect(planInteraction(record(GATE), caps())).toEqual({
			kind: "choice",
			field: "decision",
			options: GATE.root.type === "form" && GATE.root.children[0]?.type === "choice"
				? GATE.root.children[0].options
				: [],
			buttons: true,
		});
	});

	test("a lone longtext plans a reply-to text answer", () => {
		expect(planInteraction(record(form([
			{ type: "longtext", name: "reason", label: "Reason" },
		])), caps())).toEqual({ kind: "text", field: "reason" });
	});

	test("a secret field plans webui (secrets never travel through chat)", () => {
		expect(planInteraction(record(form([
			{ type: "secret", name: "token", label: "Token" },
		])), caps())).toEqual({ kind: "webui" });
	});

	test("a multi choice plans webui", () => {
		expect(planInteraction(record(form([
			{
				type: "choice", name: "decision", label: "Decision", multi: true,
				options: [{ id: "allow", label: "Allow" }],
			},
		])), caps())).toEqual({ kind: "webui" });
	});

	test("two required fields plan webui", () => {
		expect(planInteraction(record(form([
			{ type: "text", name: "first", label: "First", required: true },
			{ type: "longtext", name: "second", label: "Second", required: true },
		])), caps())).toEqual({ kind: "webui" });
	});

	test("no root form plans webui", () => {
		expect(planInteraction(record({
			v: BLOCK_SET_VERSION,
			root: { type: "markdown", text: "Approve this?" },
		}), caps())).toEqual({ kind: "webui" });
		expect(planInteraction(record(undefined), caps())).toEqual({ kind: "webui" });
	});

	test("binding-valued options plan webui", () => {
		expect(planInteraction(record(form([
			{
				type: "choice", name: "decision", label: "Decision",
				options: { $: "/options" },
			},
		])), caps())).toEqual({ kind: "webui" });
	});

	test("the buttons.max threshold selects buttons versus numbered answers", () => {
		const many = form([
			{
				type: "choice", name: "decision", label: "Decision",
				options: [1, 2, 3, 4].map((n) => ({ id: String(n), label: `Option ${n}` })),
			},
		]);
		expect(planInteraction(record(many), caps({ buttons: { max: 4 } }))).toMatchObject({ buttons: true });
		expect(planInteraction(record(many), caps({ buttons: { max: 3 } }))).toMatchObject({ buttons: false });
	});
});

describe("renderInteraction", () => {
	test("bad tone is danger, recommended is first, and labels truncate", () => {
		const rendered = renderInteraction(record(GATE), caps(), {
			conversationName: "Gateway chat",
			issue: (action) => `t:${action.kind}:${action.optionId}`,
		});
		expect(rendered.buttons).toHaveLength(1);
		expect(rendered.buttons?.[0]?.map((button) => button.label)).toEqual(["Allow", "Deny"]);
		expect(rendered.buttons?.[0]?.[1]?.style).toBe("danger");
		expect(rendered.buttons?.[0]?.[0]?.data).toBe("t:interaction:allow");
		expect(rendered.text).toContain("Allow the gated tool call?");
		expect(rendered.text).not.toContain("Reason:");
		expect(rendered.text).not.toContain("Reply with a number.");

		const recommended = form([
			{
				type: "choice", name: "decision", label: "Decision",
				options: [
					{ id: "no", label: "A very long ordinary label" },
					{ id: "yes", label: "Yes", recommended: true },
				],
			},
		]);
		const buttons = renderInteraction(record(recommended), caps(), {
			conversationName: "Gateway chat",
			issue: () => "t:synthetic",
		}).buttons?.[0];
		expect(buttons?.[0]?.label).toBe("Yes");
		expect(buttons?.[1]?.label).toHaveLength(12);
	});

	test("choice without button room renders a numbered list", () => {
		const rendered = renderInteraction(record(GATE), caps({ buttons: { max: 1 } }), {
			conversationName: "Gateway chat",
			issue: () => "t:synthetic",
		});
		expect(rendered.buttons).toBeUndefined();
		expect(rendered.text).toContain("1. Allow");
		expect(rendered.text).toContain("2. Deny");
		expect(rendered.text).toContain("Reply with a number.");
	});

	test("long text truncates to maxMessageLength with the webui note", () => {
		const tree: Tree = {
			v: BLOCK_SET_VERSION,
			root: { type: "markdown", text: "word ".repeat(100) },
		};
		const rendered = renderInteraction(record(tree), caps({ maxMessageLength: 100 }), {
			conversationName: "",
			issue: () => "t:synthetic",
		});
		expect(rendered.text.length).toBeLessThanOrEqual(100);
		expect(rendered.text).toContain("full details in the webui");
	});

	test("text and webui plans carry their answer instructions", () => {
		const text = renderInteraction(record(form([
			{ type: "longtext", name: "reason", label: "Reason" },
		])), caps(), { conversationName: "Gateway chat", issue: () => "t:synthetic" });
		expect(text.text).toContain("Reply to this message to answer.");
		const web = renderInteraction(record(undefined), caps(), {
			conversationName: "Gateway chat",
			link: "https://sigrun.example.invalid/#/c/7",
			issue: () => "t:synthetic",
		});
		expect(web.text).toContain("Answer this in the webui");
		expect(web.text).toContain("https://sigrun.example.invalid/#/c/7");
	});
});

const CHAT = { chatId: "100000001", chatType: "dm" } as const;
const KEY = bindingKey("loop", CHAT);
const CONTEXT: HandlerContext = { abortSignal: new AbortController().signal };

interface Rig {
	readonly host: Awaited<ReturnType<typeof createFakeHost>>;
	readonly prompts: PromptStore;
	readonly ledger: Ledger;
	readonly bindings: BindingStore;
	readonly identities: IdentityStore;
	readonly tokens: ButtonTokens;
	readonly channel: ChannelContribution & { sent: OutboundMessage[]; edits: { ref: MessageRef; message: OutboundMessage }[] };
	readonly config: ChannelConfig;
	readonly deliver: () => Promise<void>;
	readonly deps: Parameters<typeof createInteractionNotifier>[0];
}

async function rig(): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-interactions-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice", admin: true }, { user: "bob" }] });
	const prompts = new PromptStore(join(dir, "prompts.json"));
	const ledger = new Ledger(join(dir, "ledger.json"));
	const bindings = new BindingStore(join(dir, "bindings.json"));
	const identities = new IdentityStore(join(dir, "identities.json"));
	await identities.link("loop", "100000001", "alice", "pairing", CHAT);
	await identities.link("loop", "200000002", "bob", "pairing", { chatId: "200000002", chatType: "dm" });
	const tokens = new ButtonTokens();
	const channel = {
		id: "loop",
		label: "Loop",
		capabilities: caps({ maxMessageLength: 200 }),
		configured: () => ({ status: "ready" as const }),
		start: async () => {},
		send: async (message: OutboundMessage) => {
			channel.sent.push(message);
			return { messageIds: [`loop-${channel.sent.length}`] };
		},
		edit: async (ref: MessageRef, message: OutboundMessage) => {
			channel.edits.push({ ref, message });
		},
		sent: [] as OutboundMessage[],
		edits: [] as { ref: MessageRef; message: OutboundMessage }[],
	};
	const parsed = parseGatewayConfig({ channels: { loop: {
		dm: "allowlist",
		allow: [{ sender: "100000001", user: "alice" }, { sender: "200000002", user: "bob" }],
	} } }).channels.loop;
	if (parsed === undefined || "failed" in parsed) throw new Error("loop config failed");
	const deps: Parameters<typeof createInteractionNotifier>[0] = {
		host,
		bindings,
		identities,
		ledger,
		prompts,
		tokens,
		channelOf: (id) => id === "loop" ? channel : undefined,
		log: LOG,
	};
	return {
		host, prompts, ledger, bindings, identities, tokens, channel, config: parsed, deps,
			deliver: async () => {
			const worker = new DeliveryWorker(channel, ledger, {
				bindings, timeoutMs: 1000, delays: [1, 5, 30],
				setTimer: () => () => {}, log: LOG,
				onInteractionReceipt: async (entry, receipt) => {
					const { receiptForInteraction } = await import("../src/interactions/receipts.js");
					await receiptForInteraction(prompts, entry, receipt);
				},
			});
			await worker.drain(Date.now() + 5000);
			await worker.stop();
		},
	};
}

async function seedPending(host: Rig["host"], conversationId = 7, callId = "call-1", body = GATE): Promise<void> {
	await host.seedInteraction(conversationId as never, record(body, { callId }), CONTEXT);
}

async function promptOne(rig: Rig, user = "alice", conversationId = 7, callId = "call-1"): Promise<void> {
	await createInteractionNotifier(rig.deps).notify({
		type: "interaction.pending", conversationId, callId, user,
		title: "Sigrun needs you", body: "Approval",
	}, { host: rig.host });
}

describe("prompt delivery and answering", () => {
	test("an unbound prompt dedupes per recipient and delivers to both home chats", async () => {
		const r = await rig();
		await seedPending(r.host);
		await promptOne(r, "alice");
		await promptOne(r, "alice");
		await promptOne(r, "bob");
		await r.deliver();
		expect(r.channel.sent.filter((message) => message.chat.chatId === "100000001")).toHaveLength(1);
		expect(r.channel.sent.filter((message) => message.chat.chatId === "200000002")).toHaveLength(1);
		expect(r.ledger.list().filter((entry) => entry.kind === "interaction")).toHaveLength(2);
		expect(r.prompts.has(7, "call-1", "user:alice")).toBe(true);
		expect(r.prompts.pendingInChat("user:alice")[0]?.plan).toMatchObject({ kind: "choice", field: "decision" });
	});

	test("a bound conversation prompts once per bound chat even with two recipients", async () => {
		const r = await rig();
		await seedPending(r.host);
		await r.bindings.bind(KEY, 7, CHAT);
		await promptOne(r, "alice");
		await promptOne(r, "bob");
		await r.deliver();
		expect(r.channel.sent).toHaveLength(1);
		expect(r.prompts.has(7, "call-1", KEY)).toBe(true);
	});

	test("a button tap answers allow; a later tap replies with the outcome", async () => {
		const r = await rig();
		await seedPending(r.host);
		await promptOne(r);
		await r.deliver();
		const button = r.channel.sent[0]?.buttons?.[0]?.[0];
		if (button === undefined) throw new Error("prompt has no Allow button");
		await r.host.conversations.patchMeta(7 as never, { name: "Approval conversation" });
		const reply = await answerFromChat(r.deps, {
			conversationId: 7, callId: "call-1", values: { decision: "allow" }, user: "alice",
		});
		expect(reply).toContain("Answered");
		expect(r.host.interactions.get("7:call-1")?.answer?.values).toEqual({ decision: "allow" });
		expect(r.host.interactions.get("7:call-1")?.answeredByUser).toBe("alice");
		expect(await answerFromChat(r.deps, {
			conversationId: 7, callId: "call-1", values: { decision: "deny" }, user: "alice",
		})).toContain("Already answered");
	});

	test("an unlinked or read-only answerer is refused without writing", async () => {
		const r = await rig();
		await seedPending(r.host);
		expect(await answerFromChat(r.deps, {
			conversationId: 7, callId: "call-1", values: { decision: "allow" }, user: undefined,
		})).toContain("write access");
		expect(r.host.interactions.get("7:call-1")?.status).toBe("pending");
	});

	test("a numbered answer needs exactly one pending choice in the chat", async () => {
		const r = await rig();
		await seedPending(r.host);
		await r.bindings.bind(KEY, 7, CHAT);
		const stage = createInteractionAnswerStage(r.deps);
		await promptOne(r);
		const event: InboundEvent = {
			messageId: "m1", chat: CHAT, sender: { id: "100000001", name: "Alice" }, text: "1",
		};
		const ref: MessageRef = { chat: CHAT, messageId: "loop-1" };
		await r.prompts.record(7, "call-1", KEY, ref, planInteraction(record(GATE), caps()));
		expect(await stage("loop", event)).toEqual({ outcome: "command" });
		expect(r.host.interactions.get("7:call-1")?.answer?.values).toEqual({ decision: "allow" });

		await seedPending(r.host, 7, "call-2");
		await seedPending(r.host, 7, "call-3");
		await r.prompts.record(7, "call-2", KEY, ref, planInteraction(record(GATE), caps()));
		await r.prompts.record(7, "call-3", KEY, ref, planInteraction(record(GATE), caps()));
		expect(await stage("loop", { ...event, messageId: "m2" })).toBeUndefined();
	});

	test("a reply-to on a text prompt answers the field with the reply text", async () => {
		const r = await rig();
		const tree = form([{ type: "longtext", name: "reason", label: "Reason" }]);
		await seedPending(r.host, 7, "call-text", tree);
		await r.bindings.bind(KEY, 7, CHAT);
		await promptOne(r, "alice", 7, "call-text");
		const ref: MessageRef = { chat: CHAT, messageId: "loop-1" };
		await r.prompts.record(7, "call-text", KEY, ref, { kind: "text", field: "reason" });
		const stage = createInteractionAnswerStage(r.deps);
		expect(await stage("loop", {
			messageId: "m1", chat: CHAT, sender: { id: "100000001" }, text: "looks safe",
			replyTo: { messageId: "loop-1" },
		})).toEqual({ outcome: "command" });
		expect(r.host.interactions.get("7:call-text")?.answer?.values).toEqual({ reason: "looks safe" });
	});

	test("the pipeline routes an interaction token to the answer and sends its reply", async () => {
		const r = await rig();
		await seedPending(r.host);
		const pipeline = createPipeline({
			host: r.host, channel: r.channel, stateDir: join(r.host.stores.paths.state, "gateway"),
			log: LOG, origins: new Map(), bindings: r.bindings,
			access: {
				identities: r.identities,
				pairing: new (await import("../src/access/pairing.js")).PairingStore(join(r.host.stores.paths.state, "pairing.json")),
				linkCodes: new (await import("../src/access/link-codes.js")).LinkCodes(),
				tokens: r.tokens,
				loopGuard: new (await import("../src/access/loop-guard.js")).LoopGuard(),
			},
			interactionAnswer: async (answer) => await answerFromChat(r.deps, answer),
			stages: { interactionAnswer: createInteractionAnswerStage(r.deps) },
		});
		const token = r.tokens.issue({ kind: "interaction", conversationId: 7, callId: "call-1", field: "decision", optionId: "allow" });
		const action: ActionEvent = { chat: CHAT, sender: { id: "100000001" }, data: token };
		await pipeline.action("loop", action, r.config);
		expect(r.host.interactions.get("7:call-1")?.status).toBe("answered");
		expect(r.channel.sent.at(-1)?.text).toContain("Answered");
	});

	test("settlement edits every prompt and removes buttons; a later tap reads the outcome", async () => {
		const r = await rig();
		await seedPending(r.host);
		await promptOne(r);
		await r.deliver();
		const ref = { chat: CHAT, messageId: "loop-1" } as const;
		expect(r.prompts.refsOf(7, "call-1")).toEqual([ref]);
		await r.host.answerInteraction(7 as never, "call-1", { values: { decision: "allow" } }, CONTEXT, { user: "bob" });
		await onInteractionSettled({ conversationId: 7 as never, callId: "call-1", kind: "gate.ask", status: "answered" }, r.deps, CONTEXT);
		await r.deliver();
		expect(r.channel.edits).toHaveLength(1);
		expect(r.channel.edits[0]?.ref).toEqual(ref);
		expect(r.channel.edits[0]?.message.buttons).toBeUndefined();
		expect(r.channel.edits[0]?.message.text).toContain("allow");
		expect(r.channel.edits[0]?.message.text).toContain("bob");
		expect(r.prompts.pendingInChat(KEY)).toEqual([]);
	});
});
