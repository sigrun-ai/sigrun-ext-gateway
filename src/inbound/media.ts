/**
 * Inbound attachments (spec §8.11): lazy, capped fetches become
 * upload-backed submission parts. A failed attachment never rejects the
 * whole chat message; its pinned note is the model-visible outcome.
 */

import type {
	InboundAttachment,
	SigrunHost,
	SubmissionInputPart,
} from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { EngineLog } from "../log.js";

export const TOO_LARGE_NOTE = "[attachment skipped: too large]";
export const VOICE_NOTE = "[voice note attached; transcription unavailable]";
export const ATTACHMENT_FAILED_NOTE = "[attachment failed]";

export interface MediaDeps {
	readonly host: SigrunHost;
	readonly log: EngineLog;
}

export interface CollectedAttachments {
	readonly parts: SubmissionInputPart[];
	readonly notes: string[];
}

/** Collect every attachment independently, preserving event order. */
export async function collectAttachments(
	deps: MediaDeps,
	conversationId: number,
	attachments: readonly InboundAttachment[],
	maxBytes: number,
	signal: AbortSignal,
): Promise<CollectedAttachments> {
	const parts: SubmissionInputPart[] = [];
	const notes: string[] = [];
	for (const attachment of attachments) {
		// The declared size is the cheap gate: an already-oversize object
		// must not even open its platform download stream.
		if (attachment.size !== undefined && attachment.size > maxBytes) {
			notes.push(TOO_LARGE_NOTE);
			continue;
		}
		let bytes: Uint8Array;
		try {
			bytes = await attachment.fetch({ maxBytes, signal });
		} catch (error) {
			if (thrownName(error) === "AttachmentTooLarge") {
				notes.push(TOO_LARGE_NOTE);
			} else {
				deps.log.warn(`attachment fetch failed: ${errorMessage(error)}`);
				notes.push(ATTACHMENT_FAILED_NOTE);
			}
			continue;
		}
		try {
			const name = uploadName(attachment);
			const uploaded = await deps.host.conversations.upload(
				conversationId as ConversationId,
				{
					name,
					...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
					bytes,
				},
			);
			parts.push({
				type: attachment.kind === "image" ? "image" : "file",
				path: uploaded.path,
				...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
			});
			if (attachment.kind === "voice") notes.push(VOICE_NOTE);
		} catch (error) {
			deps.log.error("attachment upload failed", error);
			notes.push(ATTACHMENT_FAILED_NOTE);
		}
	}
	return { parts, notes };
}

/** Match adapter errors by name across realms and non-Error throw shapes. */
function thrownName(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "name" in error &&
		typeof error.name === "string"
		? error.name
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Keep upload names to the host's single-path-segment contract. */
function uploadName(attachment: InboundAttachment): string {
	const supplied = attachment.filename?.split(/[\\/]/).pop();
	if (supplied !== undefined && supplied !== "" && supplied !== "." && supplied !== "..") {
		return supplied;
	}
	return attachment.kind === "image" ? "attachment.image" : "attachment.file";
}
