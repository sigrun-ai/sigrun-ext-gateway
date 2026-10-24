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

import { newCode } from "./codes.js";

/** The pinned expiry (ms) — the same window as pairing codes. */
const LINK_TTL_MS = 3_600_000;

/** One issued code. */
interface Issued {
	readonly user: string;
	readonly channel: string;
	readonly issuedAt: number;
}

/** The outstanding self-link codes (one instance per engine). */
export class LinkCodes {
	private readonly live = new Map<string, Issued>();

	/** Issue a code binding `user` on `channel`. */
	issue(user: string, channel: string, now: number): string {
		const code = newCode();
		this.live.set(code, { user, channel, issuedAt: now });
		return code;
	}

	/**
	 * Redeem `code` on `channel`: the bound user when live and unexpired,
	 * undefined otherwise. A SUCCESSFUL redeem consumes the code; a
	 * wrong-channel or expired attempt does not (a wrong-channel probe
	 * learns nothing).
	 */
	redeem(code: string, channel: string, now: number): string | undefined {
		const issued = this.live.get(code);
		if (issued === undefined) return undefined;
		if (issued.channel !== channel) return undefined;
		if (now - issued.issuedAt >= LINK_TTL_MS) {
			this.live.delete(code);
			return undefined;
		}
		this.live.delete(code);
		return issued.user;
	}

	/**
	 * Peek WITHOUT consuming: the bound user when live, unexpired, and
	 * bound to `channel` — the self-link conflict guard reads the
	 * binding before the single-use consume so a conflict reply leaves
	 * the code live (the user fixes the link, then sends it again).
	 */
	peek(code: string, channel: string, now: number): string | undefined {
		const issued = this.live.get(code);
		if (issued === undefined) return undefined;
		if (issued.channel !== channel) return undefined;
		if (now - issued.issuedAt >= LINK_TTL_MS) return undefined;
		return issued.user;
	}

	/** Void a code outright (the group-message leak path: the code was
	 *  seen by other members, so it can never redeem again). */
	invalidate(code: string): void {
		this.live.delete(code);
	}
}
