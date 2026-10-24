/**
 * Self-link codes (spec §8.2): the single-use, channel-bound codes the
 * webui/TUI `/link <channel>` command issues and the chat-side
 * `/link <code>` redeems. Proof by holding both sessions — the code is
 * the only bridge.
 *
 * In memory by design: a restart voids outstanding codes (the user
 * re-runs `/link <channel>`; the webui session outlives nothing). The
 * pinned expiry matches pairing codes (3600000 ms).
 */
/** The outstanding self-link codes (one instance per engine). */
export declare class LinkCodes {
    private readonly live;
    /** Issue a code binding `user` on `channel`. */
    issue(user: string, channel: string, now: number): string;
    /**
     * Redeem `code` on `channel`: the bound user when live and unexpired,
     * undefined otherwise. A SUCCESSFUL redeem consumes the code; a
     * wrong-channel or expired attempt does not (a wrong-channel probe
     * learns nothing).
     */
    redeem(code: string, channel: string, now: number): string | undefined;
    /**
     * Peek WITHOUT consuming: the bound user when live, unexpired, and
     * bound to `channel` — the self-link conflict guard reads the
     * binding before the single-use consume so a conflict reply leaves
     * the code live (the user fixes the link, then sends it again).
     */
    peek(code: string, channel: string, now: number): string | undefined;
    /** Void a code outright (the group-message leak path: the code was
     *  seen by other members, so it can never redeem again). */
    invalidate(code: string): void;
}
