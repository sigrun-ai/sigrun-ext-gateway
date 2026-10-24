/**
 * Inbound attachments (spec §8.11): lazy, capped fetches become
 * upload-backed submission parts. A failed attachment never rejects the
 * whole chat message; its pinned note is the model-visible outcome.
 */
export const TOO_LARGE_NOTE = "[attachment skipped: too large]";
export const VOICE_NOTE = "[voice note attached; transcription unavailable]";
export const ATTACHMENT_FAILED_NOTE = "[attachment failed]";
/** Collect every attachment independently, preserving event order. */
export async function collectAttachments(deps, conversationId, attachments, maxBytes, signal) {
    const parts = [];
    const notes = [];
    for (const attachment of attachments) {
        // The declared size is the cheap gate: an already-oversize object
        // must not even open its platform download stream.
        if (attachment.size !== undefined && attachment.size > maxBytes) {
            notes.push(TOO_LARGE_NOTE);
            continue;
        }
        let bytes;
        try {
            bytes = await attachment.fetch({ maxBytes, signal });
        }
        catch (error) {
            if (error instanceof Error && error.name === "AttachmentTooLarge") {
                notes.push(TOO_LARGE_NOTE);
            }
            else {
                deps.log.error("attachment fetch failed", error);
                notes.push(ATTACHMENT_FAILED_NOTE);
            }
            continue;
        }
        try {
            const name = uploadName(attachment);
            const uploaded = await deps.host.conversations.upload(conversationId, {
                name,
                ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
                bytes,
            });
            parts.push({
                type: attachment.kind === "image" ? "image" : "file",
                path: uploaded.path,
                ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
            });
            if (attachment.kind === "voice")
                notes.push(VOICE_NOTE);
        }
        catch (error) {
            deps.log.error("attachment upload failed", error);
            notes.push(ATTACHMENT_FAILED_NOTE);
        }
    }
    return { parts, notes };
}
/** Keep upload names to the host's single-path-segment contract. */
function uploadName(attachment) {
    const supplied = attachment.filename?.split(/[\\/]/).pop();
    if (supplied !== undefined && supplied !== "" && supplied !== "." && supplied !== "..") {
        return supplied;
    }
    return attachment.kind === "image" ? "attachment.image" : "attachment.file";
}
