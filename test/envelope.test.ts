/**
 * buildEnvelope (Task 3, spec §8.10's envelope): group `[label] text`
 * shaping, the DM as-is pass-through, and the reply-quote prefix with
 * its 500-char truncation (the plan's pinned value).
 *
 * Tests own their literals: synthetic names and ids.
 */

import { describe, expect, test } from "vitest";
import type { InboundEvent } from "@sigrun/sigrun/extension";
import { buildEnvelope } from "../src/inbound/envelope.js";

const baseEvent = (
	over: Partial<InboundEvent> & Pick<InboundEvent, "text">,
): InboundEvent => ({
	messageId: "m1",
	chat: { chatId: "100000001", chatType: "dm" },
	sender: { id: "100000001", name: "Alice" },
	...over,
});

describe("buildEnvelope", () => {
	test("a DM renders the text as-is", () => {
		const text = buildEnvelope(baseEvent({ text: "hello" }), {
			group: false,
			senderLabel: "Alice",
		});
		expect(text).toBe("hello");
	});

	test("a group message renders [label] text", () => {
		const text = buildEnvelope(baseEvent({ text: "hello" }), {
			group: true,
			senderLabel: "Alice",
		});
		expect(text).toBe("[Alice] hello");
	});

	test("a reply in a DM prefixes the quoted block", () => {
		const text = buildEnvelope(
			baseEvent({
				text: "hello",
				replyTo: {
					messageId: "m0",
					text: "quoted line",
					authorName: "Bob",
				},
			}),
			{ group: false, senderLabel: "Alice" },
		);
		expect(text).toBe("> quoted line\n(replying to Bob)\n\nhello");
	});

	test("a reply in a group prefixes the quote before [label] text", () => {
		const text = buildEnvelope(
			baseEvent({
				text: "hello",
				replyTo: {
					messageId: "m0",
					text: "quoted line",
					authorName: "Bob",
				},
			}),
			{ group: true, senderLabel: "Alice" },
		);
		expect(text).toBe("> quoted line\n(replying to Bob)\n\n[Alice] hello");
	});

	test("the quote truncates at 500 chars (a bare ellipsis marker)", () => {
		const long = "x".repeat(600);
		const text = buildEnvelope(
			baseEvent({
				text: "hello",
				replyTo: { messageId: "m0", text: long, authorName: "Bob" },
			}),
			{ group: false, senderLabel: "Alice" },
		);
		const quoted = text.split("\n")[0] ?? "";
		expect(quoted).toBe(`> ${"x".repeat(500)}…`);
		expect(quoted.length).toBe(503);
	});

	test("a reply with no quoted text still names the author", () => {
		const text = buildEnvelope(
			baseEvent({
				text: "hello",
				replyTo: { messageId: "m0", authorName: "Bob" },
			}),
			{ group: false, senderLabel: "Alice" },
		);
		expect(text).toBe("(replying to Bob)\n\nhello");
	});

	test("a reply to the bot itself carries fromSelf without an author name", () => {
		const text = buildEnvelope(
			baseEvent({
				text: "hello",
				replyTo: { messageId: "m0", text: "earlier", fromSelf: true },
			}),
			{ group: false, senderLabel: "Alice" },
		);
		// Replying to the bot: the quote still renders (the model benefits
		// from the thread), the author line names the bot's own message
		// only when the platform supplies a name — here it doesn't.
		expect(text).toBe("> earlier\n\nhello");
	});
});
