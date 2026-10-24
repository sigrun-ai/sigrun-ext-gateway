/**
 * The bot-loop guard (spec §8.2, from Hermes): an admitted bot may send
 * at most 10 messages per chat per 60000 ms; once the cap trips, the
 * chat enters a 300000 ms cooldown during which EVERY bot message on it
 * drops. Human senders never pass through the guard.
 */

/** The pinned window (ms). */
const WINDOW_MS = 60_000;

/** The pinned per-window cap. */
const CAP = 10;

/** The pinned cooldown (ms). */
const COOLDOWN_MS = 300_000;

/** One chat's guard state. */
interface GuardState {
	/** Admit timestamps inside the current window (oldest first). */
	admits: number[];
	/** When set, bot messages drop until this instant. */
	cooldownUntil?: number;
}

/** The loop guard, one instance per engine (per chat key). */
export class LoopGuard {
	private readonly chats = new Map<string, GuardState>();

	/**
	 * May this bot message through? Records the admit on true; arms the
	 * cooldown on false (the refusal itself is the trip-wire — an
	 * attacker probing the cap re-arms the cooldown with every attempt
	 * inside it, which is exactly the behavior a loop needs stopped).
	 */
	admit(chatKey: string, now: number): boolean {
		const state = this.chats.get(chatKey) ?? { admits: [] };
		if (state.cooldownUntil !== undefined && now < state.cooldownUntil) {
			return false;
		}
		// A cooldown that lifted leaves no residue: the window restarts.
		delete state.cooldownUntil;
		const windowStart = now - WINDOW_MS;
		const inWindow = state.admits.filter((at) => at > windowStart);
		if (inWindow.length >= CAP) {
			state.cooldownUntil = now + COOLDOWN_MS;
			state.admits = inWindow;
			this.chats.set(chatKey, state);
			return false;
		}
		inWindow.push(now);
		state.admits = inWindow;
		this.chats.set(chatKey, state);
		return true;
	}
}
