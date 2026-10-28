/**
 * Durable chat-prompt bookkeeping. Ledger delivery receipts become
 * MessageRefs here; pending reads stay synchronous for inbound stage 8.
 * Settled prompts stop matching numbered/reply-to answers; their refs
 * remain so settlement can edit the delivered platform message.
 */

import type { MessageRef } from "@sigrun/sigrun/extension";
import { JsonFile } from "../state/json-file.js";
import type { ChatAnswerPlan } from "./render.js";

interface PromptRow {
	readonly conversationId: number;
	readonly callId: string;
	readonly key: string;
	readonly ref: MessageRef;
	readonly plan: ChatAnswerPlan;
}

interface PromptFile {
	readonly prompts: PromptRow[];
	settled: string[];
}

export interface PendingPrompt {
	readonly conversationId: number;
	readonly callId: string;
	readonly plan: ChatAnswerPlan;
}

export class PromptStore {
	private readonly file: JsonFile<PromptFile>;
	private rows: PromptRow[];
	private settled: Set<string>;
	/** identity → outcome text, recorded at settlement (Phase B timestamps). */
	private readonly outcomes = new Map<string, string>();

	constructor(path: string) {
		this.file = new JsonFile<PromptFile>(path, () => ({ prompts: [], settled: [] }));
		const state = this.file.readSync();
		this.rows = state.prompts;
		this.settled = new Set(state.settled);
	}

	/** Record a delivered prompt ref (idempotent for one recipient key). */
	async record(
		conversationId: number,
		callId: string,
		key: string,
		ref: MessageRef,
		plan: ChatAnswerPlan,
	): Promise<void> {
		const state = await this.file.update((draft) => {
			const identity = `${conversationId}:${callId}:${key}`;
			// A settlement raced the receipt: preserve the newly delivered
			// ref for the edit, never re-open the prompt for answers.
			if (draft.settled.includes(identity) && ref.messageId === "") return;
			const existing = draft.prompts.find((row) =>
				row.conversationId === conversationId && row.callId === callId && row.key === key
			);
			const next: PromptRow = { conversationId, callId, key, ref, plan };
			if (existing === undefined) draft.prompts.push(next);
			else draft.prompts[draft.prompts.indexOf(existing)] = next;
		});
		this.rows = state.prompts;
		this.settled = new Set(state.settled);
	}

	/** All delivered message refs for settlement edits (including settled). */
	refsOf(conversationId: number, callId: string): readonly MessageRef[] {
		return this.rows
			.filter((row) => row.conversationId === conversationId && row.callId === callId)
			.map((row) => row.ref);
	}

	/** Whether this recipient/chat already has a prompt recorded. */
	has(conversationId: number, callId: string, key: string): boolean {
		return this.rows.some((row) =>
			row.conversationId === conversationId && row.callId === callId && row.key === key
		);
	}

	/** Recipient identities for opaque-key receipt correlation. */
	pendingRecipients(conversationId: number): readonly { callId: string; key: string }[] {
		return this.rows
			.filter((row) => row.conversationId === conversationId)
			.map((row) => ({ callId: row.callId, key: row.key }));
	}

	/** Recipient keys for receipt correlation (opaque binding keys may contain colons). */
	keysOf(conversationId: number, callId: string): readonly string[] {
		return this.rows
			.filter((row) => row.conversationId === conversationId && row.callId === callId)
			.map((row) => row.key);
	}

	/** Unsettled choice/text prompts in one chat (bound key or user home key). */
	pendingInChat(bindingKey: string): readonly PendingPrompt[] {
		return this.rows
			.filter((row) => row.key === bindingKey && !this.settled.has(identityOf(row)))
			.map((row) => ({ conversationId: row.conversationId, callId: row.callId, plan: row.plan }));
	}

	/** Find the prompt behind a reply-to platform message id. */
	byReplyTo(bindingKey: string, messageId: string): PendingPrompt | undefined {
		const row = this.rows.find((candidate) =>
			candidate.key === bindingKey &&
			candidate.ref.messageId === messageId &&
			!this.settled.has(identityOf(candidate))
		);
		return row === undefined
			? undefined
			: { conversationId: row.conversationId, callId: row.callId, plan: row.plan };
	}

	/** A recipient has been enqueued even before its receipt supplies a ref. */
	async markEnqueued(conversationId: number, callId: string, key: string, plan: ChatAnswerPlan): Promise<void> {
		await this.record(conversationId, callId, key, { chat: { chatId: "", chatType: "dm" }, messageId: "" }, plan);
	}

	/** Install the real refs after the interaction ledger entry is delivered. */
	async recordReceipt(
		conversationId: number,
		callId: string,
		key: string,
		chat: MessageRef["chat"],
		messageIds: readonly string[],
	): Promise<void> {
		const existing = this.rows.find((row) =>
			row.conversationId === conversationId && row.callId === callId && row.key === key
		);
		await this.record(
			conversationId,
			callId,
			key,
			{ chat, messageId: messageIds[0] ?? "" },
			existing?.plan ?? { kind: "webui" },
		);
	}

	/** Retire pending answers while preserving refs for the settlement edit. */
	async settle(conversationId: number, callId: string, outcome = "answered"): Promise<void> {
		const keys = this.rows
			.filter((row) => row.conversationId === conversationId && row.callId === callId)
			.map(identityOf);
		const state = await this.file.update((draft) => {
			draft.settled = [...new Set([...draft.settled, ...keys])];
		});
		for (const identity of keys) this.outcomes.set(identity, outcome);
		this.rows = state.prompts;
		this.settled = new Set(state.settled);
	}

	/**
	 * The outcome text recorded at settlement, when this identity is
	 * settled. The receipt path reads it to self-heal the prompt edit.
	 */
	settledOutcome(conversationId: number, callId: string, key: string): string | undefined {
		return this.outcomes.get(`${conversationId}:${callId}:${key}`);
	}
}

function identityOf(row: Pick<PromptRow, "conversationId" | "callId" | "key">): string {
	return `${row.conversationId}:${row.callId}:${row.key}`;
}
