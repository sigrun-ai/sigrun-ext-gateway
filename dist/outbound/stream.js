/**
 * Origin-chat streaming (spec §8.6): live frames ride the conversation
 * watch, never the durable ledger. The first send waits for 20 visible
 * characters; later edits are prefix-stable and rate-limited. Final
 * chunks come from runSettled, not from the last preview frame.
 */
import { liveGenerationText } from "@sigrun/shared/live";
import { stripMarkdown } from "./markdown.js";
const FIRST_SEND_VISIBLE_CHARS = 20;
export class StreamRegistry {
    deps;
    now;
    setTimer;
    active = new Map();
    openings = new Map();
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.setTimer = deps.setTimer ?? ((fn, ms) => {
            const timer = setTimeout(fn, ms);
            return () => clearTimeout(timer);
        });
    }
    async open(conversationId, origin) {
        // One preview per conversation: a second admission is final-only;
        // abandoning here would freeze the owning run's streamed partial.
        if (this.active.has(conversationId) || this.openings.has(conversationId))
            return false;
        const opening = {};
        this.openings.set(conversationId, opening);
        try {
            const channel = this.deps.channelOf(origin.channel);
            const config = await this.deps.configOf(origin.channel);
            if (channel === undefined || config === undefined || !config.stream) {
                this.openings.delete(conversationId);
                return false;
            }
            if (channel.capabilities.edit !== undefined && channel.edit === undefined) {
                this.openings.delete(conversationId);
                this.deps.log.error(`stream: channel "${channel.id}" declares edit capabilities without edit()`);
                return false;
            }
            // Abandon/reopen while the config read was awaiting invalidates this
            // open; without the generation check it could orphan a fresh watch.
            if (this.openings.get(conversationId) !== opening)
                return false;
            let listener;
            const releaseWatch = await this.deps.host.conversations.watch(conversationId, (view) => listener?.(view));
            if (this.openings.get(conversationId) !== opening) {
                await releaseWatch();
                return false;
            }
            this.openings.delete(conversationId);
            const state = {
                conversationId,
                origin,
                channel,
                releaseWatch,
                closed: false,
                failed: false,
                lastDeliveryAt: Number.NEGATIVE_INFINITY,
                operations: Promise.resolve(),
            };
            listener = (view) => {
                if (state.closed || state.failed)
                    return;
                const text = liveGenerationText(view);
                state.operations = state.operations
                    .then(async () => this.preview(state, text))
                    .catch((error) => {
                    state.failed = true;
                    this.deps.log.error("stream preview failed", error);
                });
            };
            this.active.set(conversationId, state);
            if (channel.capabilities.edit === undefined)
                this.startTyping(state);
            return true;
        }
        catch (error) {
            // A rejected config/watch attempt owns no active stream; release
            // its slot so a later admission can retry instead of staying final-only.
            if (this.openings.get(conversationId) === opening) {
                this.openings.delete(conversationId);
            }
            throw error;
        }
    }
    async finalize(conversationId, chunks) {
        const state = this.active.get(conversationId);
        if (state === undefined)
            return false;
        this.active.delete(conversationId);
        state.closed = true;
        state.cancelEdit?.();
        state.cancelTyping?.();
        await state.releaseWatch();
        await state.operations;
        if (state.failed || state.message === undefined || chunks.length === 0)
            return false;
        try {
            // At-least-once: a failed tail send re-delivers all chunks fresh,
            // the cost of the ledger fallback (chunk 1 may duplicate).
            await this.edit(state, chunks[0]);
            for (const chunk of chunks.slice(1)) {
                await state.channel.send({ chat: state.origin.chat, text: chunk });
            }
            return true;
        }
        catch (error) {
            this.deps.log.error("stream final delivery failed", error);
            return false;
        }
    }
    abandonAll() {
        for (const conversationId of [
            ...this.active.keys(),
            ...this.openings.keys(),
        ])
            this.abandon(conversationId);
    }
    abandon(conversationId) {
        const state = this.active.get(conversationId);
        if (state === undefined) {
            // Before activation, the opening itself is the only ownership
            // handle; deleting it invalidates that pending preview.
            this.openings.delete(conversationId);
            return;
        }
        this.active.delete(conversationId);
        state.closed = true;
        state.cancelEdit?.();
        state.cancelTyping?.();
        void state.releaseWatch().catch((error) => {
            this.deps.log.error("stream watch release failed", error);
        });
    }
    startTyping(state) {
        const typing = state.channel.typing;
        const interval = state.channel.capabilities.typing?.intervalMs;
        if (typing === undefined || interval === undefined)
            return;
        const pulse = () => {
            if (state.closed)
                return;
            void typing.call(state.channel, state.origin.chat).catch((error) => {
                this.deps.log.error("stream typing failed", error);
            });
            if (!state.closed)
                state.cancelTyping = this.setTimer(pulse, interval);
        };
        state.cancelTyping = this.setTimer(pulse, interval);
    }
    async preview(state, text) {
        // Raw cumulative text preserves prefix-stability; re-formatting is
        // reserved for the authoritative final through renderChunks.
        if (state.closed || state.failed || state.channel.capabilities.edit === undefined)
            return;
        if (stripMarkdown(text).trim().length < FIRST_SEND_VISIBLE_CHARS)
            return;
        if (state.lastSent !== undefined && !text.startsWith(state.lastSent))
            return;
        if (state.message === undefined) {
            const receipt = await state.channel.send({ chat: state.origin.chat, text });
            const messageId = receipt.messageIds[0];
            if (messageId === undefined)
                throw new Error("stream send returned no message id");
            state.message = { chat: state.origin.chat, messageId };
            state.lastSent = text;
            state.lastDeliveryAt = this.now();
            return;
        }
        if (text === state.lastSent)
            return;
        const wait = Math.max(0, state.channel.capabilities.edit.minIntervalMs - (this.now() - state.lastDeliveryAt));
        if (wait > 0) {
            state.pendingText = text;
            if (state.cancelEdit === undefined) {
                state.cancelEdit = this.setTimer(() => {
                    state.cancelEdit = undefined;
                    const pending = state.pendingText;
                    state.pendingText = undefined;
                    if (pending !== undefined && !state.closed && !state.failed) {
                        state.operations = state.operations
                            .then(async () => this.preview(state, pending))
                            .catch((error) => {
                            state.failed = true;
                            this.deps.log.error("stream preview failed", error);
                        });
                    }
                }, wait);
            }
            return;
        }
        await this.edit(state, text);
        state.lastSent = text;
        state.lastDeliveryAt = this.now();
    }
    async edit(state, text) {
        if (state.message === undefined || state.channel.edit === undefined) {
            throw new Error("stream edit requires a streamed message and adapter edit()");
        }
        await state.channel.edit(state.message, { chat: state.origin.chat, text });
    }
}
