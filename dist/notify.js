/**
 * The home-chat notifier (spec §8.8): core chooses the recipients; the
 * engine turns each event into durable ledger entries for that user's
 * home DMs. Handlers only enqueue — channel workers own platform I/O.
 */
/** Build the factory-result notifier over the engine's shared stores. */
export function createNotifier(deps) {
    return {
        name: "home",
        notify: async (event) => {
            try {
                await notify(event, deps);
            }
            catch (error) {
                // A notice must never break core's other notifier deliveries;
                // the event is best-effort, but its loss is always visible.
                deps.log.error(`home notification failed (${event.type})`, error);
            }
        },
    };
}
async function notify(event, deps) {
    // Task 9 owns chat presentation for interaction records.
    if (event.type === "interaction.pending")
        return;
    if (event.user === undefined)
        return;
    const config = await deps.readConfig();
    if (!config.notify.home)
        return;
    if (event.type === "run.settled") {
        if (event.conversationId === undefined)
            return;
        // The settled fan-out owns bound conversations; a second notice
        // here would duplicate the answer the chat just received.
        if (deps.bindings.keysOf(event.conversationId).length > 0)
            return;
        const meta = await deps.host.conversations.meta(event.conversationId);
        // New-conversation jobs are unbound, but their delivery and
        // job.failed paths own notices. Core's run.settled carries no
        // outcome, so the false success notice on a failed job run needs
        // a core-contract event change and is ledgered for final review.
        if (meta.jobId !== undefined)
            return;
    }
    const text = event.type === "run.settled"
        ? `Reply ready — ${event.body}${event.url === undefined ? "" : `\n${event.url}`}`
        : `${event.title}\n${event.body}${event.url === undefined ? "" : `\n${event.url}`}`;
    for (const home of deps.identities.homesOf(event.user)) {
        await deps.ledger.enqueue({
            channel: home.channel,
            chat: home.chat,
            kind: "notice",
            message: { chat: home.chat, text },
        });
    }
}
