/** Map a delivered interaction ledger row back to its recipient key. */
import { enqueueSettlementEdits } from "./chat.js";
export async function receiptForInteraction(prompts, entry, receipt, deps) {
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
        const conversationId = Number(match[1]);
        await prompts.recordReceipt(conversationId, callId, entry.bindingKey, entry.chat, receipt.messageIds);
        await healSettledPrompt(prompts, deps, conversationId, callId, entry.bindingKey, receipt.messageIds);
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
        await healSettledPrompt(prompts, deps, conversationId, row.callId, row.key, receipt.messageIds);
        return;
    }
}
/**
 * A real receipt for an ALREADY-settled prompt self-heals the live
 * buttons: settlement ran with an empty ref (no edit possible, so a
 * notice went out), and this delivered message is the one that now
 * needs the outcome edit. The edit tag is the same the settlement
 * path would have used, so a repeat receipt stays a no-op.
 */
async function healSettledPrompt(prompts, deps, conversationId, callId, key, messageIds) {
    if (deps === undefined)
        return;
    if (messageIds.length === 0 || messageIds[0] === "")
        return;
    const outcome = prompts.settledOutcome(conversationId, callId, key);
    if (outcome === undefined)
        return;
    // Tombstones outlive their bulky rows. A receipt AFTER pruning must
    // be a true no-op: with no surviving row/ref, the settlement helper
    // would otherwise take its fallback and enqueue duplicate notices.
    const ref = prompts.refsOf(conversationId, callId)
        .find((candidate) => candidate.messageId === messageIds[0]);
    if (ref === undefined)
        return;
    try {
        await enqueueSettlementEdits(deps, conversationId, callId, outcome);
    }
    catch (error) {
        deps.log.error(`settled prompt receipt heal failed (${conversationId}:${callId})`, error);
    }
}
