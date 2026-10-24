/**
 * Inbound media (spec §8.11): declared and streamed size limits, voice
 * notes, upload-backed parts, and media-only submission behavior.
 * Tests own their literals: alice, "100000001".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type {
	ChannelContribution,
	InboundAttachment,
	InboundEvent,
	OutboundMessage,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { collectAttachments, TOO_LARGE_NOTE, VOICE_NOTE } from "../src/inbound/media.js";
import { createPipeline } from "../src/inbound/pipeline.js";
import { parseGatewayConfig } from "../src/config.js";
import type { EngineLog } from "../src/log.js";

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

function attachment(
	over: Partial<Omit<InboundAttachment, "fetch">> & {
		fetch?: InboundAttachment["fetch"];
	} = {},
): InboundAttachment {
	return {
		kind: "document",
		filename: "note.txt",
		size: 3,
		fetch: async () => new TextEncoder().encode("abc"),
		...over,
	};
}

describe("collectAttachments", () => {
	test("a declared oversize attachment is never fetched", async () => {
		const fetch = vi.fn(async () => new Uint8Array([1]));
		const result = await collectAttachments(
			{ host: await createFakeHost(), log: LOG },
			1,
			[attachment({ size: 5, fetch })],
			4,
			new AbortController().signal,
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(result).toEqual({ parts: [], notes: [TOO_LARGE_NOTE] });
	});

	test("an AttachmentTooLarge stream failure gets the size note without an error log", async () => {
		const failure = new Error("stream crossed the cap");
		failure.name = "AttachmentTooLarge";
		const error = vi.fn();
		const result = await collectAttachments(
			{ host: await createFakeHost(), log: { ...LOG, error } },
			1,
			[attachment({ size: undefined, fetch: async () => { throw failure; } })],
			4,
			new AbortController().signal,
		);
		expect(result).toEqual({ parts: [], notes: [TOO_LARGE_NOTE] });
		expect(error).not.toHaveBeenCalled();
	});

	test("an ordinary fetch failure is noted and warned", async () => {
		const warn = vi.fn();
		const result = await collectAttachments(
			{ host: await createFakeHost(), log: { ...LOG, warn } },
			1,
			[attachment({ fetch: async () => { throw new Error("network down"); } })],
			4,
			new AbortController().signal,
		);
		expect(result).toEqual({ parts: [], notes: ["[attachment failed]"] });
		expect(warn).toHaveBeenCalledOnce();
	});

	test("AttachmentTooLarge matches by name on any thrown value shape", async () => {
		const result = await collectAttachments(
			{ host: await createFakeHost(), log: LOG },
			1,
			[attachment({ fetch: async () => { throw { name: "AttachmentTooLarge" }; } })],
			4,
			new AbortController().signal,
		);
		expect(result.notes).toEqual([TOO_LARGE_NOTE]);
	});

	test("images upload as image parts and other kinds as file parts", async () => {
		const host = await createFakeHost();
		const result = await collectAttachments(
			{ host, log: LOG },
			7,
			[
				attachment({ kind: "image", filename: "pixel.png", mime: "image/png" }),
				attachment({ kind: "document", filename: "note.txt", mime: "text/plain" }),
			],
			4,
			new AbortController().signal,
		);
		expect(result.parts).toEqual([
			{ type: "image", path: "uploads/7/pixel.png", mime: "image/png" },
			{ type: "file", path: "uploads/7/note.txt", mime: "text/plain" },
		]);
	});

	test("a voice note uploads as a file and adds the pinned transcription note", async () => {
		const result = await collectAttachments(
			{ host: await createFakeHost(), log: LOG },
			1,
			[attachment({ kind: "voice", filename: "voice.ogg", mime: "audio/ogg" })],
			4,
			new AbortController().signal,
		);
		expect(result.parts).toEqual([
			{ type: "file", path: "uploads/1/voice.ogg", mime: "audio/ogg" },
		]);
		expect(result.notes).toEqual([VOICE_NOTE]);
	});
});

describe("pipeline media submission", () => {
	test("every album sibling's attachments join the one merged submission", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-media-album-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
		const block = parseGatewayConfig({
			channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
		}).channels.loop;
		if (block === undefined || "failed" in block) throw new Error("bad test config");
		const pipeline = createPipeline({
			host,
			channel: {
				id: "loop",
				label: "Loop",
				capabilities: { chatTypes: ["dm"], maxMessageLength: 200, format: "markdown" },
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: async () => ({ messageIds: [] }),
			},
			stateDir: dir,
			log: LOG,
			origins: new Map(),
			stages: {
				attachments: (event) => collectAttachments(
					{ host, log: LOG },
					1,
					event.attachments ?? [],
					1024,
					new AbortController().signal,
				),
			},
		});
		await Promise.all([1, 2, 3].map((n) => pipeline("loop", {
			messageId: `album-${n}`,
			groupId: "album-media",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001" },
			text: `part ${n}`,
			attachments: [attachment({ kind: "image", filename: `image-${n}.png`, mime: "image/png" })],
		}, block)));
		await pipeline.flushAlbums();
		const submissions = host.calls.filter((call) => call.method === "conversations.submit");
		expect(submissions).toHaveLength(1);
		const parts = submissions[0]?.args[1] as readonly { type: string; path?: string }[];
		expect(parts.filter((part) => part.type === "image").map((part) => part.path)).toEqual([
			"uploads/1/image-1.png",
			"uploads/1/image-2.png",
			"uploads/1/image-3.png",
		]);
	});

	test("a media-only message submits its parts and notes without an empty text part", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-media-pipeline-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host: FakeHost = await createFakeHost({
			storesDir: dir,
			users: [{ user: "alice" }],
		});
		const settings = {
			channels: {
				loop: {
					dm: "allowlist",
					allow: [{ sender: "100000001", user: "alice" }],
				},
			},
		};
		const block = parseGatewayConfig(settings).channels.loop;
		if (block === undefined || "failed" in block) throw new Error("bad test config");
		const channel: ChannelContribution = {
			id: "loop",
			label: "Loop",
			capabilities: { chatTypes: ["dm"], maxMessageLength: 200, format: "markdown" },
			configured: () => ({ status: "ready" }),
			start: async () => {},
			send: async (_message: OutboundMessage) => ({ messageIds: [] }),
		};
		const pipeline = createPipeline({
			host,
			channel,
			stateDir: dir,
			log: LOG,
			origins: new Map(),
			stages: {
				attachments: (event) => collectAttachments(
					{ host, log: LOG },
					1,
					event.attachments ?? [],
					1024,
					new AbortController().signal,
				),
			},
		});
		const event: InboundEvent = {
			messageId: "media-only",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001", name: "Alice" },
			text: "",
			attachments: [attachment({ kind: "image", filename: "pixel.png", mime: "image/png" })],
		};
		expect(await pipeline("loop", event, block)).toEqual({ outcome: "admitted" });
		const submit = host.calls.find((call) => call.method === "conversations.submit");
		expect(submit?.args[1]).toEqual([
			{ type: "image", path: "uploads/1/pixel.png", mime: "image/png" },
		]);
	});

	test("an empty event without attachments submits a text part, never an empty array", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-media-empty-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
		const block = parseGatewayConfig({
			channels: { loop: { dm: "allowlist", allow: [{ sender: "100000001", user: "alice" }] } },
		}).channels.loop;
		if (block === undefined || "failed" in block) throw new Error("bad test config");
		const pipeline = createPipeline({
			host,
			channel: {
				id: "loop",
				label: "Loop",
				capabilities: { chatTypes: ["dm"], maxMessageLength: 200, format: "markdown" },
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: async () => ({ messageIds: [] }),
			},
			stateDir: dir,
			log: LOG,
			origins: new Map(),
		});
		await pipeline("loop", {
			messageId: "empty",
			chat: { chatId: "100000001", chatType: "dm" },
			sender: { id: "100000001" },
			text: "",
		}, block);
		const submit = host.calls.find((call) => call.method === "conversations.submit");
		expect(submit?.args[1]).toEqual([{ type: "text", text: "" }]);
	});
});
