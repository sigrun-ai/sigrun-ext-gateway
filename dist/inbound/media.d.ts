/**
 * Inbound attachments (spec §8.11): lazy, capped fetches become
 * upload-backed submission parts. A failed attachment never rejects the
 * whole chat message; its pinned note is the model-visible outcome.
 */
import type { InboundAttachment, SigrunHost, SubmissionInputPart } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
export declare const TOO_LARGE_NOTE = "[attachment skipped: too large]";
export declare const VOICE_NOTE = "[voice note attached; transcription unavailable]";
export declare const ATTACHMENT_FAILED_NOTE = "[attachment failed]";
export interface MediaDeps {
    readonly host: SigrunHost;
    readonly log: EngineLog;
}
export interface CollectedAttachments {
    readonly parts: SubmissionInputPart[];
    readonly notes: string[];
}
/** Collect every attachment independently, preserving event order. */
export declare function collectAttachments(deps: MediaDeps, conversationId: number, attachments: readonly InboundAttachment[], maxBytes: number, signal: AbortSignal): Promise<CollectedAttachments>;
