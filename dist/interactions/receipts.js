/** Map a delivered interaction ledger row back to its recipient key. */
export async function receiptForInteraction(prompts, entry, receipt) {
    // The receipt is authoritative: an early settlement may have removed
    // the pending row, but the delivered message still needs an edit ref.
    if (entry.bindingKey !== undefined) {
        const match = entry.tag?.match(/^interaction:(\d+):(.+)$/);
        if (match === null || match === undefined)
            return;
        const suffix = `:${entry.bindingKey}`;
        if (!match[2].endsWith(suffix))
            return;
        const callId = match[2].slice(0, -suffix.length);
        await prompts.recordReceipt(Number(match[1]), callId, entry.bindingKey, entry.chat, receipt.messageIds);
        return;
    }
    const tag = entry.tag;
    if (tag === undefined || !tag.startsWith("interaction:"))
        return;
    const rest = tag.slice("interaction:".length);
    const separator = rest.indexOf(":");
    if (separator < 0)
        return;
    const conversationId = Number(rest.slice(0, separator));
    const afterConversation = rest.slice(separator + 1);
    if (!Number.isInteger(conversationId))
        return;
    // Unbound home keys have no ledger bindingKey; the pending rows'
    // callIds are the other side of the persisted identity.
    for (const row of prompts.pendingRecipients(conversationId)) {
        const suffix = `${row.callId}:${row.key}`;
        if (afterConversation !== suffix)
            continue;
        await prompts.recordReceipt(conversationId, row.callId, row.key, entry.chat, receipt.messageIds);
        return;
    }
}
