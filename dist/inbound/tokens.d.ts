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
/** What a button does when tapped. */
export type TokenAction = {
    readonly kind: "pair";
    readonly code: string;
    readonly decision: "approve" | "deny";
    readonly user?: string;
} | {
    readonly kind: "interaction";
    readonly conversationId: number;
    readonly callId: string;
    readonly optionId: string;
};
/** The button-token table, one instance per engine. */
export declare class ButtonTokens {
    private readonly live;
    /** Mint a token for `action` (the `data` a button carries). */
    issue(action: TokenAction): string;
    /** Resolve a tap: the action, consumed (undefined on replay). */
    resolve(token: string): TokenAction | undefined;
}
