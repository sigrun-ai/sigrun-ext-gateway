/**
 * Interaction notification and settlement fan-out. Handlers only enqueue
 * durable ledger entries; delivery receipts populate PromptStore refs so
 * settlement can edit the exact platform messages.
 */
import { summarizeValues } from "./answer.js";
import { planInteraction, renderInteraction, truncateInteractionText } from "./render.js";
/** The gateway notifier: interaction.pending plus the ordinary home notifier. */
export function createInteractionNotifier(deps) {
    return {
        name: "gateway",
        notify: async (event) => {
            if (event.type !== "interaction.pending")
                return;
            if (event.conversationId === undefined || event.callId === undefined)
                return;
            try {
                await notifyInteraction(event, deps);
            }
            catch (error) {
                deps.log.error(`interaction prompt failed (${event.conversationId}:${event.callId})`, error);
            }
        },
    };
}
async function notifyInteraction(event, deps) {
    const keys = deps.bindings.keysOf(event.conversationId);
    const targets = [];
    if (keys.length > 0) {
        for (const key of keys) {
            const binding = deps.bindings.get(key);
            if (binding === undefined || binding.dead === true)
                continue;
            targets.push({ key, channel: key.split(":")[0], chat: binding.chat, bindingKey: key });
        }
    }
    else if (event.user !== undefined) {
        for (const home of deps.identities.homesOf(event.user)) {
            targets.push({ key: `user:${event.user}`, channel: home.channel, chat: home.chat });
        }
    }
    // Resolve and dedupe targets BEFORE reading the record. The read is a
    // PEEK: the gateway owns NO secret delivery (secret records are
    // webui-plan), so it must never consume one — peekInteraction is the
    // non-consuming inspection read (a settled secret's one-shot delivery
    // belongs to the owning extension's snapshotInteraction alone).
    const pendingTargets = targets.filter((target) => !deps.prompts.has(event.conversationId, event.callId, target.key));
    if (pendingTargets.length === 0)
        return;
    const context = deps.context ?? { abortSignal: new AbortController().signal };
    const record = await deps.host.peekInteraction(event.conversationId, event.callId, context);
    if (record === undefined || record.status !== "pending")
        return;
    // A settle can land while the render above awaited: re-check BEFORE
    // the first enqueue so an already-settled interaction never gets a
    // live prompt (the buttons would only answer "Already answered.").
    const still = await deps.host.peekInteraction(event.conversationId, event.callId, context);
    if (still === undefined || still.status !== "pending")
        return;
    for (const target of pendingTargets) {
        const channel = deps.channelOf(target.channel);
        if (channel === undefined) {
            deps.log.warn(`interaction prompt skipped: no channel "${target.channel}"`);
            continue;
        }
        const plan = planInteraction(still, channel.capabilities);
        const rendered = renderInteraction(still, channel.capabilities, {
            conversationId: event.conversationId,
            conversationName: (await deps.host.conversations.meta(event.conversationId)).name ?? `Conversation ${event.conversationId}`,
            ...(event.url === undefined ? {} : { link: event.url }),
            issue: (action) => deps.tokens.issue(action.kind === "interaction"
                ? { ...action, conversationId: event.conversationId }
                : action),
        });
        // The ledger enqueue precedes the prompt row: the ledger tag is
        // the durable dedupe, so a throwing enqueue must NOT leave a row
        // that would suppress this target on every replay.
        await deps.ledger.enqueue({
            channel: target.channel,
            ...(target.bindingKey === undefined ? {} : { bindingKey: target.bindingKey }),
            chat: target.chat,
            kind: "interaction",
            message: { chat: target.chat, ...rendered },
            tag: `interaction:${event.conversationId}:${event.callId}:${target.key}`,
        });
        await deps.prompts.markEnqueued(event.conversationId, event.callId, target.key, plan);
    }
}
/** Enqueue outcome edits/notices and retire numbered/reply-to matching. */
export async function onInteractionSettled(event, deps, context) {
    try {
        // NEVER snapshotInteraction here: that read is the one-shot SECRET
        // delivery (it merges the true values back once, then deletes the
        // entry) — an outcome edit that consumed it would silently destroy
        // the extension's only chance to receive the secret. The widened C6
        // event carries everything chat rendering needs (the stored answer
        // is masked by construction — secrets never persist).
        const outcome = outcomeText(event);
        await enqueueSettlementEdits(deps, event.conversationId, event.callId, outcome);
        await deps.prompts.settle(event.conversationId, event.callId, outcome);
    }
    catch (error) {
        deps.log.error(`interaction settlement delivery failed (${String(event.conversationId)}:${event.callId})`, error);
    }
}
/** The outcome summary the settlement edit/notice carries. */
function outcomeText(event) {
    const who = event.answeredByUser === undefined ? "" : ` by ${event.answeredByUser}`;
    // SAFETY: the stored answer's values are validated JsonValue (the
    // record's answer shape); the payload types them loosely because
    // the contract cannot import the json module's runtime shape.
    const answerValues = (event.answer ?? {});
    return event.status === "answered"
        ? `answered${who}: ${summarizeValues(answerValues)}`
        : `${event.status}${who}`;
}
/**
 * Enqueue the settlement edits (or, when no ref is editable, the
 * fallback outcome notices). Called at settlement AND from the receipt
 * path when a real delivery ref arrives for an ALREADY-settled prompt:
 * settlement that beats the receipt leaves no editable ref, so the
 * late receipt is the last chance to replace the live buttons.
 */
export async function enqueueSettlementEdits(deps, conversationId, callId, outcome) {
    const editableChannels = new Set();
    const refs = deps.prompts.refsOf(conversationId, callId);
    for (const ref of refs) {
        const id = channelForRef(deps, conversationId, callId, ref);
        const channel = id === undefined ? undefined : deps.channelOf(id);
        if (channel?.capabilities.edit !== undefined && channel.edit !== undefined && ref.messageId !== "") {
            editableChannels.add(channel.id);
            const bindingKey = deps.bindings.keysOf(conversationId).find((key) => {
                const binding = deps.bindings.get(key);
                return binding?.chat.chatId === ref.chat.chatId && binding.chat.threadId === ref.chat.threadId;
            });
            await deps.ledger.enqueue({
                channel: channel.id,
                ...(bindingKey === undefined ? {} : { bindingKey }),
                chat: ref.chat,
                kind: "edit",
                ref,
                message: { chat: ref.chat, text: truncateInteractionText(`Interaction ${outcome}.`, channel.capabilities.maxMessageLength) },
                tag: `interaction-settled:${conversationId}:${callId}:${channel.id}:${ref.messageId}`,
            });
        }
    }
    if (editableChannels.size === 0) {
        for (const key of deps.bindings.keysOf(conversationId)) {
            const binding = deps.bindings.get(key);
            const channelId = key.split(":")[0];
            if (binding === undefined || binding.dead === true)
                continue;
            await deps.ledger.enqueue({
                channel: channelId,
                bindingKey: key,
                chat: binding.chat,
                kind: "notice",
                message: { chat: binding.chat, text: `Interaction ${outcome}.` },
                tag: `interaction-settled-notice:${conversationId}:${callId}:${key}`,
            });
        }
    }
}
/** Recover the channel from the binding key/home prompt target. */
function channelForRef(deps, conversationId, callId, ref) {
    for (const key of deps.bindings.keysOf(conversationId)) {
        const binding = deps.bindings.get(key);
        if (binding?.chat.chatId === ref.chat.chatId && binding.chat.threadId === ref.chat.threadId)
            return key.split(":")[0];
    }
    return promptChannel(deps, conversationId, callId, ref);
}
function promptChannel(deps, conversationId, callId, ref) {
    // PromptStore persists refs, not a second channel mapping. The ledger's
    // interaction entry is the authoritative channel attribution.
    const entry = deps.ledger.list().find((candidate) => candidate.kind === "interaction" &&
        candidate.tag?.startsWith(`interaction:${conversationId}:${callId}:`) === true &&
        candidate.chat.chatId === ref.chat.chatId);
    return entry?.channel;
}
