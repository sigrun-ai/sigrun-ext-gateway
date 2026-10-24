/**
 * StreamRegistry (Task 6): live frames send/edit only at the pinned
 * thresholds, non-prefix frames never reshape a streamed message, the
 * settled chunks are authoritative, and no-edit channels type until
 * finalize. Tests own their literals and run on fake timers.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationViewWire } from "@sigrun/shared/views";
import type {
	ChannelCapabilities,
	ChannelContribution,
	ChatRef,
	MessageRef,
	OutboundMessage,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { parseGatewayConfig, type ChannelConfig } from "../src/config.js";
import { StreamRegistry } from "../src/outbound/stream.js";
import type { EngineLog } from "../src/log.js";

const CHAT: ChatRef = { chatId: "100000001", chatType: "dm" };
const ORIGIN = { channel: "loop", bindingKey: "loop:default:dm:100000001", chat: CHAT };

interface Sent {
	readonly message: OutboundMessage;
	readonly ref?: MessageRef;
}

interface Rig {
	readonly host: FakeHost;
	readonly registry: StreamRegistry;
	readonly sent: Sent[];
	readonly edits: Sent[];
	readonly typing: ChatRef[];
	readonly errors: string[];
	readonly close: () => Promise<void>;
}

function silentLog(errors: string[]): EngineLog {
	return {
		info: () => {},
		warn: () => {},
		debug: () => {},
		once: () => {},
		error: (message, error) => errors.push(`${message}: ${String(error)}`),
	};
}

function liveView(text: string): ConversationViewWire {
	return {
		conversation: { id: 7 },
		entries: [],
		steer: { busy: true, queued: 0 },
		docs: {
			"pi.live": {
				run: { id: "run-1" },
				generation: {
					message: { content: [{ type: "text", text }] },
				},
			},
		},
	};
}

async function rig(overrides: {
	readonly capabilities?: Partial<ChannelCapabilities>;
	readonly failEdit?: boolean;
} = {}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-stream-"));
	const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
	const sent: Sent[] = [];
	const edits: Sent[] = [];
	const typing: ChatRef[] = [];
	const errors: string[] = [];
	const capabilities: ChannelCapabilities = {
		chatTypes: ["dm"],
		maxMessageLength: 200,
		format: "markdown",
		edit: { minIntervalMs: 100 },
		typing: { intervalMs: 50 },
		...overrides.capabilities,
	};
	const channel: ChannelContribution = {
		id: "loop",
		label: "Loop",
		capabilities,
		configured: () => ({ status: "ready" }),
		start: async () => {},
		send: async (message) => {
			sent.push({ message });
			return { messageIds: [`loop-${sent.length}`] };
		},
		edit: capabilities.edit === undefined ? undefined : async (ref, message) => {
			if (overrides.failEdit === true) throw new Error("synthetic edit failure");
			edits.push({ ref, message });
		},
		typing: async (chat) => {
			typing.push(chat);
		},
	};
	const parsed = parseGatewayConfig({ channels: { loop: { stream: true } } }).channels.loop;
	if (parsed === undefined || "failed" in parsed) throw new Error("test config failed");
	const config: ChannelConfig = parsed;
	const registry = new StreamRegistry({
		host,
		channelOf: (id) => id === "loop" ? channel : undefined,
		configOf: async (id) => id === "loop" ? config : undefined,
		log: silentLog(errors),
	});
	return {
		host,
		registry,
		sent,
		edits,
		typing,
		errors,
		close: async () => rm(dir, { recursive: true, force: true }),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("StreamRegistry edit streaming", () => {
	test("frames respect the 20-visible-character threshold, prefix stability, throttle, and authoritative finalize", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			harness.host.pushView(7 as ConversationId, liveView("Hel"));
			harness.host.pushView(7 as ConversationId, liveView("Hello wor"));
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent).toHaveLength(0);

			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent.map((row) => row.message.text)).toEqual(["Hello world, this is"]);

			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is long"));
			await vi.advanceTimersByTimeAsync(99);
			expect(harness.edits).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.edits.map((row) => row.message.text)).toEqual(["Hello world, this is long"]);

			harness.host.pushView(7 as ConversationId, liveView("A replacement that is not a prefix"));
			await vi.advanceTimersByTimeAsync(200);
			expect(harness.edits).toHaveLength(1);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is long enough"));
			await vi.advanceTimersByTimeAsync(100);
			expect(harness.edits).toHaveLength(2);
			for (let index = 1; index < harness.edits.length; index++) {
				expect(harness.edits[index]!.message.text.startsWith(harness.edits[index - 1]!.message.text)).toBe(true);
			}

			const owned = await harness.registry.finalize(7, ["The settled answer, not the preview"]);
			expect(owned).toBe(true);
			expect(harness.edits.at(-1)?.message.text).toBe("The settled answer, not the preview");
			expect(harness.host.watchCount(7 as ConversationId)).toBe(0);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is long enough after release"));
			await vi.advanceTimersByTimeAsync(200);
			expect(harness.edits.at(-1)?.message.text).toBe("The settled answer, not the preview");
		} finally {
			await harness.close();
		}
	});

	test("reopening a live conversation is a no-op and its owning settle replaces the partial", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent).toHaveLength(1);
			expect(await harness.registry.open(7, ORIGIN)).toBe(false);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is still live"));
			await vi.advanceTimersByTimeAsync(100);
			expect(harness.edits.at(-1)?.message.text).toBe("Hello world, this is still live");
			expect(harness.sent).toHaveLength(1);
			expect(await harness.registry.finalize(7, ["First run's settled answer"])).toBe(true);
			expect(harness.edits.at(-1)?.message.text).toBe("First run's settled answer");
		} finally {
			await harness.close();
		}
	});

	test("a failed watch releases the opening slot so a retry can succeed", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		const watch = harness.host.conversations.watch.bind(harness.host.conversations);
		let fail = true;
		harness.host.conversations.watch = (async (...args: Parameters<typeof watch>) => {
			if (fail) {
				fail = false;
				throw new Error("synthetic watch failure");
			}
			return watch(...args);
		}) as typeof harness.host.conversations.watch;
		try {
			await expect(harness.registry.open(7, ORIGIN)).rejects.toThrow("synthetic watch failure");
			expect(await harness.registry.open(7, ORIGIN)).toBe(true);
		} finally {
			await harness.close();
		}
	});

	test("an absent channel config makes open return false", async () => {
		const harness = await rig();
		const registry = new StreamRegistry({
			host: harness.host,
			channelOf: () => undefined,
			configOf: async () => undefined,
			log: silentLog([]),
		});
		try {
			expect(await registry.open(7, ORIGIN)).toBe(false);
		} finally {
			await harness.close();
		}
	});

	test("a multi-chunk final edits chunk one and sends the rest", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			expect(await harness.registry.finalize(7, ["settled first", "settled second"])).toBe(true);
			expect(harness.edits.at(-1)?.message.text).toBe("settled first");
			expect(harness.sent.map((row) => row.message.text)).toEqual([
				"Hello world, this is",
				"settled second",
			]);
		} finally {
			await harness.close();
		}
	});

	test("an edit failure stops streaming and finalize returns false", async () => {
		vi.useFakeTimers();
		const harness = await rig({ failEdit: true });
		try {
			await harness.registry.open(7, ORIGIN);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is long"));
			await vi.advanceTimersByTimeAsync(100);
			expect(harness.errors.some((line) => line.includes("synthetic edit failure"))).toBe(true);
			expect(await harness.registry.finalize(7, ["fresh final"])).toBe(false);
			expect(harness.edits).toHaveLength(0);
		} finally {
			await harness.close();
		}
	});

	test("abandon releases the watch", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			harness.registry.abandon(7);
			expect(harness.host.watchCount(7 as ConversationId)).toBe(0);
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent).toHaveLength(0);
		} finally {
			await harness.close();
		}
	});

	test("abandonAll releases every active stream", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			harness.registry.abandonAll();
			harness.host.pushView(7 as ConversationId, liveView("Hello world, this is"));
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent).toHaveLength(0);
		} finally {
			await harness.close();
		}
	});

	test("an unterminated code fence mid-stream does not throw", async () => {
		vi.useFakeTimers();
		const harness = await rig();
		try {
			await harness.registry.open(7, ORIGIN);
			expect(() => harness.host.pushView(
				7 as ConversationId,
				liveView("```ts\nconst answer = 'unterminated but visible'"),
			)).not.toThrow();
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.sent).toHaveLength(1);
		} finally {
			await harness.close();
		}
	});
});

describe("StreamRegistry typing fallback", () => {
	test("no-edit capabilities type at the interval and stop at finalize", async () => {
		vi.useFakeTimers();
		const harness = await rig({ capabilities: { edit: undefined } });
		try {
			await harness.registry.open(7, ORIGIN);
			await vi.advanceTimersByTimeAsync(120);
			expect(harness.typing).toHaveLength(2);
			expect(await harness.registry.finalize(7, ["fresh final"])).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			expect(harness.typing).toHaveLength(2);
			expect(harness.sent).toHaveLength(0);
			expect(harness.edits).toHaveLength(0);
		} finally {
			await harness.close();
		}
	});
});
