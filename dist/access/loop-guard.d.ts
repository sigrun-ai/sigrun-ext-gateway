/**
 * The bot-loop guard (spec §8.2, from Hermes): an admitted bot may send
 * at most 10 messages per chat per 60000 ms; once the cap trips, the
 * chat enters a 300000 ms cooldown during which EVERY bot message on it
 * drops. Human senders never pass through the guard.
 */
/** The loop guard, one instance per engine (per chat key). */
export declare class LoopGuard {
    private readonly chats;
    /**
     * May this bot message through? Records the admit on true; arms the
     * cooldown on false (the refusal itself is the trip-wire — an
     * attacker probing the cap re-arms the cooldown with every attempt
     * inside it, which is exactly the behavior a loop needs stopped).
     */
    admit(chatKey: string, now: number): boolean;
}
