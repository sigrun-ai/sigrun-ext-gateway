/**
 * The inbound pipeline (spec §8.4): one `receive` runs the ordered
 * steps. Task 3 implements steps 2 (dedupe), 3 (self/bot drops — the
 * bot loop guard's counting arrives with the group admission task),
 * 5 (allowlist/link DMs only; groups arrive with their own task), 6
 * (album merge) and 10 (submit) plus the M12 submit-error outcomes.
 * Steps 1 (claimed gate), 4 (self-link), 7 (commands), 8 (interaction
 * answers) and 9 (attachments) are INJECTABLE STAGES
 * (`PipelineDeps.stages`) filled by their own tasks — the design keeps
 * the step ORDER in one place while each task lands its logic.
 *
 * The channel's config is read LIVE per event by the CALLER (the
 * engine's `receive` wrapper reads `readConfig(host)` and passes the
 * channel's block in) — every field except `enabled` is per-event.
 *
 * On admission the pipeline records `submissionId → { bindingKey,
 * channel }` in `deps.origins` (the in-memory map the outbound tasks
 * consume — which chat a run came from, so settled answers route).
 *
 * The notice/error replies go through `deps.channel.send` — the
 * adapter-bound transport, host-independent (the loopback fixture's
 * `sent` array records them, which is how the sigrun e2e asserts reply
 * text). A failed notice send is logged, never thrown: the submit
 * error already resolved the event's fate.
 */
import { join } from "node:path";
import { buildEnvelope } from "./envelope.js";
import { AlbumCollector, ALBUM_WINDOW_MS } from "./albums.js";
import { bindingKey, BindingStore } from "../state/bindings.js";
import { SeenSet } from "../state/seen.js";
import { IdentityStore } from "../state/identities.js";
/** The pinned UnservedModelError notice (spec §8.4 M12, exact copy). */
const UNSERVED_MODEL_NOTICE = "The model <ref> is not available. Use /model to pick another.";
/**
 * Build the pipeline over the deps. ONE pipeline per engine (the state
 * stores are shared across channels; the binding key carries the
 * channel) — the engine wires every supervised channel's
 * `ChannelContext.receive` through it.
 */
export function createPipeline(deps) {
    const now = deps.now ?? Date.now;
    const bindings = new BindingStore(join(deps.stateDir, "bindings.json"), {
        now,
    });
    const seen = new SeenSet(join(deps.stateDir, "seen.json"));
    const identities = new IdentityStore(join(deps.stateDir, "identities.json"), { log: deps.log });
    const albums = new AlbumCollector(now, ALBUM_WINDOW_MS);
    // Per-group close timers (the album window's flush).
    const albumTimers = new Map();
    return async (channelId, event, config) => {
        const key = bindingKey(channelId, event.chat);
        const seenId = `${key}:${event.messageId}`;
        // Step 1 — the claimed gate (injected; absent = claimed posture).
        if (deps.stages?.claimedGate?.(channelId) === true) {
            return dropped();
        }
        // Step 2 — dedupe (in-flight-aware: a racing redelivery claims
        // false and drops; an engine failure releases for the retry).
        if (!seen.claim(seenId, now())) {
            return dropped();
        }
        try {
            return await admit(channelId, event, key, config);
        }
        catch (error) {
            // An unexpected throw is an ENGINE failure: release the seen id
            // (the platform redelivers) and reject — the adapter does not
            // ack, so the message is retried rather than lost.
            seen.release(seenId);
            throw error;
        }
    };
    /** The pipeline past the dedupe claim. */
    async function admit(channelId, event, key, config) {
        // Step 3 — self and bot drops.
        if (event.fromSelf === true)
            return dropped();
        if (event.sender.isBot === true && !config.allowBots) {
            return dropped();
        }
        // Step 4 — self-link (`/link <code>`): handled before access.
        const selfLink = await deps.stages?.selfLink?.(channelId, event);
        if (selfLink !== undefined)
            return selfLink;
        // Step 5 — access: Task 3 admits DMs only. Groups arrive with
        // Task 8's admission stage; everything else drops.
        if (event.chat.chatType !== "dm") {
            return dropped();
        }
        const resolved = identities.userFor(config, channelId, event.sender.id);
        if (resolved === undefined) {
            // Unknown DM sender: the pairing reply arrives with Task 4's
            // pairing stage; the drop (with its once-per-sender log) is
            // the honest Task 3 posture.
            deps.log.once(`dm-drop:${channelId}:${event.sender.id}`, "info", `dm from unknown sender dropped (channel "${channelId}")`);
            return dropped();
        }
        // The bound conversation, or a fresh one for an unbound chat.
        const binding = bindings.get(key);
        if (binding?.dead) {
            await bindings.clearDead(key);
        }
        let conversationId;
        if (binding === undefined) {
            conversationId = (await deps.host.conversations.create({
                owner: resolved.user,
                source: "gateway",
                name: event.chat.title ?? `${deps.channel.label} DM`,
            }));
            await bindings.bind(key, conversationId, event.chat);
        }
        else {
            conversationId = binding.conversationId;
            // An archived conversation unarchives before submit (spec
            // §8.3's my-call: archiving never silently breaks a chat).
            const meta = await deps.host.conversations.meta(conversationId);
            if (meta.archived) {
                await deps.host.conversations.patchMeta(conversationId, {
                    archived: false,
                });
            }
        }
        // Step 7 — commands (injected; Task 7 fills).
        const command = await deps.stages?.command?.(channelId, event, conversationId);
        if (command !== undefined) {
            await seen.commit(`${key}:${event.messageId}`, now());
            return command;
        }
        // Step 8 — interaction text answers (injected; Task 9 fills).
        const interaction = await deps.stages?.interactionAnswer?.(channelId, event);
        if (interaction !== undefined) {
            await seen.commit(`${key}:${event.messageId}`, now());
            return interaction;
        }
        // Step 6 — the album merge: a group's events become ONE
        // submission when the window closes; a plain event is its own.
        const envelopeText = buildEnvelope(event, {
            group: false,
            senderLabel: event.sender.name ?? event.sender.id,
        });
        const batch = albums.add(key, event, envelopeText);
        if (batch === undefined) {
            // Collecting: commit seen NOW (the events ARE admitted — a
            // platform redelivery of a held sibling is a no-op) and arm
            // the close timer that submits the merged batch.
            await seen.commit(`${key}:${event.messageId}`, now());
            scheduleAlbumClose(channelId, key, event, resolved.user, conversationId, config);
            return { outcome: "admitted" };
        }
        // Step 10 — submit.
        return await submit(channelId, event, key, conversationId, resolved.user, batch, config);
    }
    /** Step 10: the submit + the M12 error outcomes. */
    async function submit(channelId, event, key, conversationId, user, batch, config) {
        const text = batch.join("\n");
        const parts = [
            ...(deps.stages?.attachments === undefined
                ? []
                : await deps.stages.attachments(event)),
            { type: "text", text },
        ];
        const opts = {
            user,
            requestId: `${key}:${event.messageId}`,
            whenBusy: config.busy,
        };
        try {
            const record = await deps.host.conversations.submit(conversationId, parts, opts);
            await seen.commit(`${key}:${event.messageId}`, now());
            deps.origins.set(record.id, {
                bindingKey: key,
                channel: channelId,
            });
            return { outcome: "admitted" };
        }
        catch (error) {
            if (error instanceof Error &&
                error.name === "UnservedModelError") {
                // The pinned notice with the ref interpolated (M12). Named
                // by `name`, never `instanceof` across the types-only
                // contract (the error class ships in sigrun's runtime, not
                // the extension types).
                const ref = unservedModelRef(error);
                await sendNotice(event.chat, UNSERVED_MODEL_NOTICE.replace("<ref>", ref));
                await seen.commit(`${key}:${event.messageId}`, now());
                return dropped();
            }
            if (error instanceof Error &&
                error.name === "ConversationOpError") {
                // A short notice + the error code logged (M12).
                const code = conversationOpCode(error);
                deps.log.error(`submit failed (conversation ${String(conversationId)}, code "${code}")`, error);
                await sendNotice(event.chat, "Could not deliver that message. Try again in a moment.");
                await seen.commit(`${key}:${event.messageId}`, now());
                return dropped();
            }
            throw error;
        }
    }
    /** Send one notice reply through the adapter (errors logged, never thrown). */
    async function sendNotice(chat, text) {
        const message = { chat, text };
        try {
            await deps.channel.send(message);
        }
        catch (error) {
            deps.log.error("notice send failed", error);
        }
    }
    /** Arm the album-close timer for a collecting group (one per group). */
    function scheduleAlbumClose(channelId, key, event, user, conversationId, config) {
        if (event.groupId === undefined)
            return;
        const timerKey = `${key}:${event.groupId}`;
        if (albumTimers.has(timerKey))
            return;
        const timer = setTimeout(() => {
            albumTimers.delete(timerKey);
            const texts = albums.close(key, event.groupId ?? "");
            if (texts.length === 0)
                return;
            void submit(channelId, event, key, conversationId, user, texts, config)
                .catch((error) => {
                // The timer path has no receive to reject: an unexpected
                // throw logs loud (the album's events are committed seen;
                // the M12 classes already resolved their own outcome).
                deps.log.error("album submit failed", error);
            });
        }, ALBUM_WINDOW_MS);
        albumTimers.set(timerKey, timer);
    }
}
/** Extract the `provider/modelId` ref from an UnservedModelError-like. */
function unservedModelRef(error) {
    const ref = error.ref;
    if (ref?.provider !== undefined && ref.modelId !== undefined) {
        return `${ref.provider}/${ref.modelId}`;
    }
    return "the configured model";
}
/** Extract the error code from a ConversationOpError-like. */
function conversationOpCode(error) {
    const body = error
        .body;
    return body?.error ?? error.message;
}
/** The dropped outcome. */
function dropped() {
    return { outcome: "dropped" };
}
