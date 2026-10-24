/**
 * onRunSettled (spec §8.6's "which runs deliver" + the M7 access
 * re-check): the engine's `runSettled` factory handler. ONLY ENQUEUES —
 * the per-channel delivery workers own the platform calls.
 *
 * - Every key in `bindings.keysOf(conversationId)` that is not dead
 *   gets a final (whoever started the run — ruling 4: a webui submit
 *   into a bound conversation delivers to the chat).
 * - Access is RE-CHECKED per delivery (M7): `meta` + `accessOf` for
 *   the binding's user — the LINKED user for DMs, the group owner for
 *   groups. A failed check UNBINDS the chat, logs it, and enqueues
 *   nothing.
 * - An answered run renders the answer's text blocks (thinking and
 *   tool calls are never shown); an answer with NO text blocks gets
 *   the pinned "(no text reply)" notice (Review Focus 4 — an empty
 *   send is a platform rejection, never an honest reply).
 * - The origin-chat streaming hand-off is Task 6's seam
 *   (`deps.streams.finalize`, a no-op stub returning false here);
 *   when the stream owns delivery, no final entries enqueue.
 * - An unanswered run notifies the ORIGIN chat only (from
 *   `deps.origins`): the pinned "Stopped." for an abort reason, a
 *   short reason notice otherwise.
 */
import { renderChunks } from "./render.js";
/** The pinned notice for a textless answer (Review Focus 4). */
export const NO_TEXT_REPLY = "(no text reply)";
/** The pinned abort notice (spec §8.6: "An abort from /stop produces Stopped."). */
export const STOPPED = "Stopped.";
/**
 * The settled-run handler: enqueue finals (or the empty-answer notice)
 * for every live bound chat, and the unanswered notice for the origin
 * chat. Never throws (the event bus's bounded handler owns isolation,
 * but a ledger failure must not lose the rest of the fan-out).
 */
export async function onRunSettled(event, deps) {
    try {
        await run(event, deps);
    }
    catch (error) {
        // A fan-out failure is logged loud: the entries that landed stay
        // queued (the ledger is the source of truth), the lost ones log
        // their conversation (§8.6: nothing is dropped silently).
        deps.log.error(`settled fan-out failed (conversation ${String(event.conversationId)})`, error);
    }
}
/** The body (isolated from the catch so a partial fan-out still logs). */
async function run(event, deps) {
    const conversationId = event.conversationId;
    if (event.outcome.status === "answered") {
        await fanOutAnswer(event, deps, conversationId);
        return;
    }
    await notifyOrigin(event, deps);
}
/** The answered fan-out: every live bound key, access-checked. */
async function fanOutAnswer(event, deps, conversationId) {
    const keys = deps.bindings.keysOf(conversationId);
    if (keys.length === 0)
        return;
    // The answer's visible text: text blocks joined (thinking/tool calls
    // are never shown — §8.6).
    const text = answerText(event);
    // The origin-chat streaming hand-off (Task 6's seam), consulted ONCE
    // per conversation (before the fan-out): when the stream owned the
    // ORIGIN chat's delivery, that one key is skipped — the rest of the
    // fan-out still runs (the seam owns one chat, never the whole set).
    const streamed = await deps.streams.finalize(conversationId);
    for (const key of keys) {
        const binding = deps.bindings.get(key);
        if (binding === undefined || binding.dead === true)
            continue;
        // A channel config that is ABSENT or {failed} is a CONFIG problem,
        // not a revoked binding: the binding is KEPT (a config typo must
        // never silently delete chats) and the fan-out skips with a log.
        const channel = channelOfFor(deps, key);
        if (channel === undefined) {
            deps.log.warn(`settled: no channel adapter for binding "${key}" — skipped, binding kept`);
            continue;
        }
        const config = await deps.configOf(key.split(":")[0] ?? "");
        if (config === undefined) {
            deps.log.warn(`settled: channel config unavailable for binding "${key}" — skipped, binding kept`);
            continue;
        }
        // M7: the access re-check. DM bindings resolve their user through
        // the SAME allowlist-then-link resolution admission ran; group
        // bindings use the config's owner. A FAILED CHECK (a present config
        // whose user is unresolvable, or access "none") unbinds, logs, skips.
        const meta = await deps.host.conversations.meta(conversationId);
        const user = await bindingUser(deps, config, key, binding.chat);
        if (user === undefined || meta === undefined) {
            await unbindAndLog(deps, conversationId, key, "user unresolvable");
            continue;
        }
        const access = await deps.host.access.accessOf({ user }, { owner: meta.owner, sharing: meta.sharing });
        if (access === "none") {
            await unbindAndLog(deps, conversationId, key, `access revoked for user "${user}"`);
            continue;
        }
        const chunks = text === "" ? [NO_TEXT_REPLY] : renderChunks(text, channel.capabilities, channel.format);
        // The stream owns the ORIGIN chat (the chat the run streamed to):
        // that key is skipped; every other key still enqueues.
        if (streamed && key === originKeyOf(deps, event)?.bindingKey) {
            continue;
        }
        for (let index = 0; index < chunks.length; index++) {
            await deps.ledger.enqueue({
                channel: channel.id,
                bindingKey: key,
                chat: binding.chat,
                kind: text === "" ? "notice" : "final",
                message: { chat: binding.chat, text: chunks[index] },
                // The tag is chunk-indexed: a multi-chunk final's entries are
                // distinct rows (a replayed settle re-dedupes the whole set).
                tag: `final:${conversationId}:${String(event.outcome.answerEntryId)}:${key}:${index}`,
            });
        }
    }
}
/** The unanswered notice: the origin chat only. */
async function notifyOrigin(event, deps) {
    const origin = originKeyOf(deps, event);
    if (origin === undefined) {
        // A run the engine never admitted (webui-started, a job): no chat
        // to notify — the webui shows the failure itself.
        return;
    }
    const binding = deps.bindings.get(origin.bindingKey);
    if (binding === undefined || binding.dead === true)
        return;
    const channel = deps.channelOf(origin.channel);
    if (channel === undefined) {
        deps.log.warn(`settled: no channel "${origin.channel}" for the unanswered notice`);
        return;
    }
    const text = event.outcome.reason === "aborted"
        ? STOPPED
        : `Could not answer: ${event.outcome.reason}`;
    await deps.ledger.enqueue({
        channel: origin.channel,
        bindingKey: origin.bindingKey,
        chat: binding.chat,
        kind: "notice",
        message: { chat: binding.chat, text },
        // Tagged: a replayed settle re-dedupes (the same rule the finals
        // carry).
        tag: `notice:${String(event.conversationId)}:${origin.bindingKey}`,
    });
}
/**
 * The origin record of the event's run: the LAST input's record (the
 * run's final submission — an album's batch shares one record per
 * submit). Undefined when the engine never admitted the run.
 */
function originKeyOf(deps, event) {
    for (const id of [...event.inputs].reverse()) {
        const origin = deps.origins.get(id);
        if (origin !== undefined)
            return origin;
    }
    return undefined;
}
/** The binding's user: the DM's resolved user (allowlist then link —
 *  the SAME resolution the admission ran), the group owner for a group (M7).
 *  The config is the CALLER's (the fan-out already verified it present). */
async function bindingUser(deps, config, key, chat) {
    const channel = key.split(":")[0] ?? "";
    if (chat.chatType === "dm") {
        // A DM binding's chat id IS the platform sender id: the admission's
        // own resolution (allowlist first, then the stored link) — the
        // allowlist mapping outlives the link.
        return deps.identities.userFor(config, channel, chat.chatId)?.user;
    }
    // A group binding's user is the configured OWNER (spec §8.2: the
    // group's owner is who the run acts for).
    const group = config.groups.find((entry) => entry.chat === chat.chatId && !("failed" in entry));
    return group === undefined || "failed" in group ? undefined : group.owner;
}
/** The channel adapter for a binding key's channel segment. */
function channelOfFor(deps, key) {
    const channel = key.split(":")[0];
    return deps.channelOf(channel);
}
/** Unbind + log (the M7 revoked-access path). */
async function unbindAndLog(deps, conversationId, key, reason) {
    await deps.bindings.unbind(key);
    deps.log.info(`settled: unbound "${key}" from conversation ${String(conversationId)} (${reason})`);
}
/** The answer's visible text (text blocks joined). */
function answerText(event) {
    return event.outcome.answer.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
