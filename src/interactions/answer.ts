/**
 * Write-gated answers originating in chat. Identity resolution belongs
 * to the pipeline/tap caller; this module independently re-checks
 * conversation write access immediately before answering.
 */

import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@sigrun/shared/blocks";
import type {
	HandlerContext,
	InboundEvent,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { bindingKey, type BindingStore } from "../state/bindings.js";
import type { IdentityStore } from "../state/identities.js";
import type { PromptStore } from "./prompts.js";

export interface AnswerDeps {
	readonly host: SigrunHost;
	readonly bindings: BindingStore;
	readonly identities: IdentityStore;
	readonly prompts: PromptStore;
	readonly context?: HandlerContext;
	/** Direct adapter reply (the pipeline supplies it; unit callers need not). */
	readonly reply?: (event: InboundEvent, text: string) => Promise<void>;
}

export interface ChatAnswer {
	readonly conversationId: number;
	readonly callId: string;
	readonly values: Record<string, JsonValue>;
	readonly user: string | undefined;
}

const TERMINAL = new Set(["answered", "skipped", "expired", "cancelled"]);

/** Answer after proving the named chat user can still write the conversation. */
export async function answerFromChat(
	deps: AnswerDeps,
	answer: ChatAnswer,
): Promise<string> {
	if (answer.user === undefined) return "You do not have write access to this conversation.";
	const meta = await deps.host.conversations.meta(answer.conversationId as ConversationId);
	const access = await deps.host.access.accessOf(
		{ user: answer.user },
		{ owner: meta.owner, sharing: meta.sharing },
	);
	if (access !== "write") return "You do not have write access to this conversation.";
	// Terminal-snapshot invariant: secret-bearing records are webui-plan,
	// so no chat answer reaches this consuming read. Widening the planner
	// requires a non-consuming snapshot before any terminal path reads one.
	const record = await deps.host.snapshotInteraction(
		answer.conversationId as ConversationId,
		answer.callId,
		deps.context ?? { abortSignal: new AbortController().signal },
	);
	if (record !== undefined && TERMINAL.has(record.status)) {
		return `Already ${outcomeOf(record)}.`;
	}
	if (record === undefined) return "That interaction is no longer available.";
	const answered = await deps.host.answerInteraction(
		answer.conversationId as ConversationId,
		answer.callId,
		{ values: answer.values },
		deps.context ?? { abortSignal: new AbortController().signal },
		{ user: answer.user },
	);
	if (!answered) {
		// A lost race: someone else's answer won. NEVER snapshotInteraction
		// here — that read takes the WINNER's one-shot secret delivery
		// (Review Focus 4: the delivery belongs to the winner's extension
		// read; a losing path consuming it would destroy the secret).
		return "Already answered.";
	}
	return `Answered: ${summarizeValues(answer.values)}.`;
}

/** One shared human-readable outcome for settlement edits and stale taps. */
export function outcomeOf(record: {
	readonly status: string;
	readonly answer?: { readonly values: Readonly<Record<string, JsonValue>> };
	readonly answeredByUser?: string;
}): string {
	const who = record.answeredByUser === undefined ? "" : ` by ${record.answeredByUser}`;
	if (record.status === "answered") {
		return `answered${who}: ${summarizeValues(record.answer?.values ?? {})}`;
	}
	return `${record.status}${who}`;
}

export function summarizeValues(values: Readonly<Record<string, JsonValue>>): string {
	const parts = Object.entries(values).map(([field, value]) => {
		const rendered = typeof value === "string" ? value : JSON.stringify(value);
		return `${field}=${rendered ?? "null"}`;
	});
	return parts.length === 0 ? "no values" : parts.join(", ");
}

/** Stage 8: consume a numbered or reply-to answer, else continue admission. */
export function createInteractionAnswerStage(
	deps: AnswerDeps & {
		readonly configOf?: (channel: string) => Promise<import("../config.js").ChannelConfig | undefined>;
	},
): (channelId: string, event: InboundEvent) => Promise<{ outcome: "command" } | undefined> {
	return async (channelId, event) => {
		const key = bindingKey(channelId, event.chat);
		const config = await deps.configOf?.(channelId);
		const user = config === undefined
			? deps.identities.linkedUserOf(channelId, event.sender.id)
			: deps.identities.userFor(config, channelId, event.sender.id)?.user;
		const lookupKeys = user === undefined ? [key] : [key, `user:${user}`];
		const lookup = <T>(read: (candidate: string) => T | undefined): T | undefined => {
			for (const candidate of lookupKeys) {
				const found = read(candidate);
				if (found !== undefined) return found;
			}
			return undefined;
		};
		let prompt: { conversationId: number; callId: string; values: Record<string, JsonValue> } | undefined;
		const replyTarget = event.replyTo?.messageId;
		if (replyTarget !== undefined) {
			const replied = lookup((candidate) => deps.prompts.byReplyTo(candidate, replyTarget));
			if (replied?.plan.kind === "text") {
				prompt = {
					conversationId: replied.conversationId,
					callId: replied.callId,
					values: { [replied.plan.field]: event.text },
				};
			}
		}
		if (prompt === undefined && /^\d+$/.test(event.text.trim())) {
			const pending = lookup((candidate) => {
				const rows = deps.prompts.pendingInChat(candidate);
				return rows.length === 0 ? undefined : rows;
			});
			if (pending?.length === 1) {
				const selected = pending[0]!;
				const plan = selected.plan;
				if (plan.kind !== "choice") return undefined;
				const index = Number(event.text.trim()) - 1;
				const options = [...plan.options].sort((a, b) =>
					Number(b.recommended === true) - Number(a.recommended === true)
				);
				const option = options[index];
				if (option === undefined) {
					await deps.reply?.(event, `Answer number out of range (1-${options.length}).`);
					return { outcome: "command" };
				}
				prompt = {
					conversationId: selected.conversationId,
					callId: selected.callId,
					values: { [plan.field]: option.id },
				};
			}
		}
		if (prompt === undefined) return undefined;
		const reply = await answerFromChat(deps, { ...prompt, user });
		await deps.reply?.(event, reply);
		return { outcome: "command" };
	};
}
