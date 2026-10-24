/**
 * Button tokens (spec §8.7 §12 "opaque transport-private button
 * tokens"): the opaque `data` strings the engine puts on chat buttons
 * and resolves when a tap arrives. Opaque BY DESIGN — a token carries
 * no readable decision, so a screenshot or log line leaks nothing an
 * attacker could replay through a different chat.
 *
 * Single-use on resolve: a tap consumes its token, so a replayed tap
 * (a double delivery, a copied message) is a no-op. In memory — a
 * restart voids outstanding tokens, which only ever adorn live chat
 * messages.
 *
 * Task 9 (chat interactions) mints the `kind: "interaction"` tokens
 * through this same class: ONE table per engine, every button routes
 * through it.
 */
import { randomInt } from "node:crypto";
/** The token alphabet (RFC 4648 base32 — the Crockford-adjacent set). */
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The pinned token body length (16 chars, `t:`-prefixed). */
const TOKEN_LENGTH = 16;
/** The button-token table, one instance per engine. */
export class ButtonTokens {
    live = new Map();
    /** Mint a token for `action` (the `data` a button carries). */
    issue(action) {
        let body = "";
        for (let i = 0; i < TOKEN_LENGTH; i++) {
            body += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
        }
        const token = `t:${body}`;
        this.live.set(token, action);
        return token;
    }
    /** Resolve a tap: the action, consumed (undefined on replay). */
    resolve(token) {
        const action = this.live.get(token);
        if (action !== undefined)
            this.live.delete(token);
        return action;
    }
}
