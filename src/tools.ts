/**
 * The chat-facing agent tools (spec §8.9). Policy failures are ordinary
 * error results, never exceptions. Sends persist to the delivery ledger
 * before waiting for a receipt, so a timeout leaves honest queued work.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type {
	ChannelContribution,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import type { BindingStore } from "./state/bindings.js";
import type { IdentityStore } from "./state/identities.js";
import type { Ledger, LedgerEntry } from "./state/ledger.js";
import { resolveTargets } from "./jobs.js";
import type { GatewayConfig } from "./config.js";
import type { EngineLog } from "./log.js";

export const RECEIPT_WAIT_MS = 30_000;
const RECEIPT_POLL_MS = 25;

export interface ToolDeps {
	readonly host: SigrunHost;
	readonly bindings: BindingStore;
	readonly identities: IdentityStore;
	readonly ledger: Ledger;
	channelOf(channel: string): ChannelContribution | undefined;
	readConfig(): Promise<GatewayConfig>;
	readonly log: EngineLog;
	/** Poke the channel's worker after enqueueing. */
	readonly kick?: () => void;
	readonly receiptWaitMs?: number;
}

/** Build both tools over the engine's shared state. */
export function createGatewayTools(deps: ToolDeps): readonly ToolRegistration[] {
	const sendMessage = defineTool({
		name: "send_message",
		description:
			"Send a message to one of the acting user's linked chats. `to` is a channel or channel:chatId; files are workspace paths.",
		parameters: Type.Object({
			to: Type.String({ description: "Target channel or channel:chatId" }),
			text: Type.String({ description: "Message text" }),
			files: Type.Optional(Type.Array(Type.String(), {
				description: "Workspace paths of files to attach",
			})),
		}),
		async execute(args, api, context) {
			try {
				const owner = await deps.host.identity.actingUser(api.conversationId);
				if (owner === undefined) return toolError("The acting user could not be resolved.");
				if (deps.identities.homesOf(owner).length === 0) {
					return toolError(`The acting user ${owner} has no linked chats.`);
				}
				const targets = await resolveTargets(deps, owner, [args.to]);
				const target = targets.resolved[0];
				if (target === undefined) {
					return toolError(targets.rejected[0]?.reason ?? "The target chat is not available.");
				}
				const channel = deps.channelOf(target.channel);
				if (channel === undefined) {
					return toolError(`Channel "${target.channel}" is not running.`);
				}
				const config = await deps.readConfig();
				const files: {
					conversationId: number;
					path: string;
					name: string;
					mime?: string;
					bytes: Uint8Array;
				}[] = [];
				for (const path of args.files ?? []) {
					const read = await deps.host.conversations.readFile(api.conversationId, path);
					if (read.bytes.byteLength > config.media.maxBytes) {
						return toolError(`File "${path}" is too large (limit ${config.media.maxBytes} bytes).`);
					}
					const kind = mediaKind(read.mime, path);
					const supported = channel.capabilities.media ?? [];
					if (!supported.includes(kind) && !supported.includes("document")) {
						return toolError(`Channel "${channel.label}" does not support ${kind} files or document fallback.`);
					}
					files.push({
						conversationId: api.conversationId as number,
						path,
						name: fileName(path),
						...(read.mime === undefined ? {} : { mime: read.mime }),
						bytes: read.bytes,
					});
				}
				const entry = await deps.ledger.enqueue({
					channel: target.channel,
					chat: target.chat,
					kind: "notice",
					message: {
						chat: target.chat,
						text: args.text,
						...(files.length === 0
							? {}
							: {
								files: files.map((file) => ({
									name: file.name,
									...(file.mime === undefined ? {} : { mime: file.mime }),
									bytes: file.bytes,
								})),
							}),
					},
					...(files.length === 0 ? {} : { files }),
				});
				if (entry === undefined) return toolError("The message could not be queued.");
				deps.kick?.();
				const receipt = await waitForReceipt(
					deps.ledger,
					entry,
					deps.receiptWaitMs ?? RECEIPT_WAIT_MS,
					context.abortSignal ?? new AbortController().signal,
				);
				if (receipt === undefined) {
					return toolSuccess({ delivered: false, queued: true });
				}
				return toolSuccess({ delivered: true, messageIds: receipt });
			} catch (error) {
				// Transport and host errors are also model-recoverable tool
				// outcomes; logging retains the diagnostic policy errors lack.
				deps.log.error("send_message failed", error);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	});

	const listChats = defineTool({
		name: "list_chats",
		description: "List chats the acting user may target with send_message.",
		parameters: Type.Object({}),
		async execute(_args, api) {
			try {
				const owner = await deps.host.identity.actingUser(api.conversationId);
				if (owner === undefined) return toolError("The acting user could not be resolved.");
				const chats: { to: string; label: string }[] = [];
				const seen = new Set<string>();
				for (const home of deps.identities.homesOf(owner)) {
					const channel = deps.channelOf(home.channel);
					if (channel === undefined) continue;
					seen.add(`${home.channel}:${home.chat.chatId}`);
					chats.push({
						to: home.channel,
						label: `${channel.label} direct message ${home.chat.chatId}`,
					});
				}
				for (const [key, binding] of Object.entries(deps.bindings.entries())) {
					if (binding.dead === true) continue;
					const channelId = key.split(":", 1)[0];
					if (channelId === undefined) continue;
					const channel = deps.channelOf(channelId);
					if (channel === undefined) continue;
					const access = await deps.host.access.accessOf(
						{ user: owner },
						await deps.host.conversations.meta(binding.conversationId as import("@earendil-works/pi-durable").ConversationId),
					);
					if (access !== "write") continue;
					const target = `${channelId}:${binding.chat.chatId}`;
					if (seen.has(target)) continue;
					seen.add(target);
					chats.push({
						to: target,
						label: `${channel.label} ${binding.chat.chatType === "dm" ? "direct message" : "group"} ${binding.chat.chatId}`,
					});
				}
				if (chats.length === 0) {
					return toolError(`The acting user ${owner} has no linked chats.`);
				}
				return toolSuccess({ chats });
			} catch (error) {
				deps.log.error("list_chats failed", error);
				return toolError(error instanceof Error ? error.message : String(error));
			}
		},
	});
	return [sendMessage, listChats];
}

function toolError(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(value: Record<string, unknown>): ToolExecutionResult {
	return { output: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Poll the durable row so a same-process worker receipt resolves quickly. */
async function waitForReceipt(
	ledger: Ledger,
	entry: LedgerEntry,
	waitMs: number,
	signal: AbortSignal,
): Promise<readonly string[] | undefined> {
	const deadline = Date.now() + waitMs;
	while (!signal.aborted) {
		const current = ledger.list().find((candidate) => candidate.id === entry.id);
		if (current?.state === "delivered") return current.receipt ?? [];
		if (current?.state === "failed") return undefined;
		if (Date.now() >= deadline) return undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, Math.min(RECEIPT_POLL_MS, Math.max(0, deadline - Date.now())));
			const abort = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				resolve();
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	return undefined;
}

function fileName(path: string): string {
	return path.split(/[\\/]/).pop() ?? "attachment";
}

function mediaKind(mime: string | undefined, path: string): "image" | "audio" | "video" | "document" {
	if (mime?.startsWith("image/") === true) return "image";
	if (mime?.startsWith("audio/") === true) return "audio";
	if (mime?.startsWith("video/") === true) return "video";
	if (mime !== undefined) return "document";
	const extension = path.split(".").pop()?.toLowerCase();
	if (extension !== undefined && ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) return "image";
	if (extension !== undefined && ["ogg", "mp3", "wav", "m4a"].includes(extension)) return "audio";
	if (extension !== undefined && ["mp4", "webm", "mov"].includes(extension)) return "video";
	return "document";
}
