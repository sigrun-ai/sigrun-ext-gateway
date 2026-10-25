/**
 * Agent chat tools (spec §8.9): target policy, file capability mapping,
 * durable enqueueing, receipt waits, and chat enumeration.
 * Tests own their literals: alice/bob, "100000001".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ChannelContribution } from "@sigrun/sigrun/extension";
import { afterAll, describe, expect, test } from "vitest";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";
import { IdentityStore } from "../src/state/identities.js";
import { Ledger } from "../src/state/ledger.js";
import { createGatewayTools, RECEIPT_WAIT_MS } from "../src/tools.js";
import type { EngineLog } from "../src/log.js";

const HOME = { chatId: "100000001", chatType: "dm" } as const;
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const LOG: EngineLog = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	once: () => {},
};

function channel(media: readonly ("image" | "audio" | "video" | "document")[] = ["document"]): ChannelContribution {
	return {
		id: "loop",
		label: "Loop",
		capabilities: { chatTypes: ["dm", "group"], maxMessageLength: 200, format: "markdown", media },
		configured: () => ({ status: "ready" }),
		start: async () => {},
		send: async () => ({ messageIds: ["loop-1"] }),
	};
}

async function rig(media?: readonly ("image" | "audio" | "video" | "document")[]) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-tools-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host: FakeHost = await createFakeHost({
		storesDir: dir,
		users: [{ user: "alice" }, { user: "bob" }],
	});
	const conversationId = await host.conversations.create({ owner: "alice" });
	const bindings = new BindingStore(join(dir, "bindings.json"));
	const identities = new IdentityStore(host, join(dir, "identities.json"));
	await identities.link("loop", "100000001", "alice", "pairing", HOME);
	const ledger = new Ledger(join(dir, "ledger.json"));
	const tools = createGatewayTools({
		host,
		bindings,
		identities,
		ledger,
		channelOf: (id) => id === "loop" ? channel(media) : undefined,
		readConfig: async () => (await import("../src/config.js")).readConfig(host),
		log: LOG,
		receiptWaitMs: 20,
	});
	const api = { conversationId, callId: "tool-call-1" } as ToolExecutionApi;
	const call = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing tool ${name}`);
		return await tool.execute(args, api, BACKGROUND_CONTEXT);
	};
	const output = (result: ToolExecutionResult): string => {
		const first = result.output?.[0];
		return first?.type === "text" ? first.text : "";
	};
	return { host, conversationId, bindings, identities, ledger, call, output };
}

describe("send_message", () => {
	test("the pinned receipt wait is 30000 ms", () => {
		expect(RECEIPT_WAIT_MS).toBe(30_000);
	});

	test("refuses a target outside the acting user's home and writable bindings", async () => {
		const { call, output, ledger } = await rig();
		const result = await call("send_message", { to: "loop:999", text: "hello" });
		expect(result.isError).toBe(true);
		expect(output(result)).toContain("not bound to a writable conversation");
		expect(ledger.list()).toEqual([]);
	});

	test("refuses a target bound to another user's private conversation", async () => {
		const { host, bindings, call, ledger } = await rig();
		const foreign = await host.conversations.create({ owner: "bob" });
		const chat = { chatId: "42", chatType: "group" } as const;
		await bindings.bind(bindingKey("loop", chat), foreign as number, chat);
		const result = await call("send_message", { to: "loop:42", text: "hello" });
		expect(result.isError).toBe(true);
		expect(ledger.list()).toEqual([]);
	});

	test("an unsupported media kind falls back to document", async () => {
		const { host, conversationId, call, output, ledger } = await rig(["document"]);
		const upload = await host.conversations.upload(conversationId, {
			name: "pixel.png",
			mime: "image/png",
			bytes: new Uint8Array([1, 2]),
		});
		const pending = call("send_message", {
			to: "loop",
			text: "image attached",
			files: [upload.path],
		});
		while (ledger.list().length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const entry = ledger.list()[0];
		expect(entry?.message.files?.[0]?.name).toBe("pixel.png");
		expect(entry?.tag).toBe("tool:tool-call-1");
		await ledger.mark(entry!.id, "delivered", ["loop-9"]);
		const result = await pending;
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(output(result))).toEqual({ delivered: true, messageIds: ["loop-9"] });
	});

	test("an unsupported kind with no document fallback is a tool error", async () => {
		const { host, conversationId, call, output } = await rig([]);
		const upload = await host.conversations.upload(conversationId, {
			name: "voice.ogg",
			mime: "audio/ogg",
			bytes: new Uint8Array([1]),
		});
		const result = await call("send_message", { to: "loop", text: "voice", files: [upload.path] });
		expect(result.isError).toBe(true);
		expect(output(result)).toContain("does not support");
	});

	test("a file over media.maxBytes is refused", async () => {
		const { host, conversationId, call, output } = await rig();
		await host.stores.settings.set({ media: { maxBytes: 1 } });
		const upload = await host.conversations.upload(conversationId, {
			name: "note.txt",
			mime: "text/plain",
			bytes: new Uint8Array([1, 2]),
		});
		const result = await call("send_message", { to: "loop", text: "file", files: [upload.path] });
		expect(result.isError).toBe(true);
		expect(output(result)).toContain("too large");
	});

	test("a receipt timeout returns queued while retaining the pending entry", async () => {
		const { call, output, ledger } = await rig();
		const result = await call("send_message", { to: "loop", text: "queued" });
		expect(JSON.parse(output(result))).toEqual({ delivered: false, queued: true });
		expect(result.isError).toBeUndefined();
		expect(ledger.list()[0]?.state).toBe("pending");
	});

	test("a terminal delivery failure returns an error, not a queued result", async () => {
		const { call, output, ledger } = await rig();
		const pending = call("send_message", { to: "loop", text: "will fail" });
		while (ledger.list().length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await ledger.mark(ledger.list()[0]!.id, "failed");
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(output(result)).toBe("Delivery failed; the message was not sent.");
	});

	test("a user with no linked chats gets an explanatory refusal", async () => {
		const { host, bindings, identities, ledger, call, output } = await rig();
		await identities.forgetHomes("alice");
		const result = await call("send_message", { to: "loop", text: "hello" });
		expect(result.isError).toBe(true);
		expect(output(result)).toContain("no linked chats");
		expect(bindings.entries()).toEqual({});
		expect(host.identity.actingUser).toBeDefined();
		expect(ledger.list()).toEqual([]);
	});
});

describe("list_chats", () => {
	test("lists the acting user's home and writable bound chats with labels", async () => {
		const { host, bindings, call, output } = await rig();
		const owned = await host.conversations.create({ owner: "alice" });
		const chat = { chatId: "42", chatType: "group" } as const;
		await bindings.bind(bindingKey("loop", chat), owned as number, chat);
		const result = await call("list_chats", {});
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(output(result))).toEqual({
			chats: [
				{ to: "loop", label: "Loop direct message 100000001" },
				{ to: "loop:42", label: "Loop group 42" },
			],
		});
	});
});
