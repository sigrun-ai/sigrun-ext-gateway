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
        // here would duplicate the answer the chat just received. Only
        // LIVE bindings suppress: a dead binding is skipped by the
        // fan-out, so counting it would drop the answer with no log.
        const live = deps.bindings.keysOf(event.conversationId)
            .filter((key) => deps.bindings.get(key)?.dead !== true);
        if (live.length > 0)
            return;
        const meta = await deps.host.conversations.meta(event.conversationId);
        // New-conversation jobs are unbound, but their delivery and
        // job.failed paths own notices. The settled outcome (Task 4) is
        // structured on the event: only an ANSWERED run may read as a
        // ready reply; a failed/aborted run is a truthful non-success
        // notice carrying the run's own reason.
        if (meta.jobId !== undefined)
            return;
    }
    const text = event.type === "run.settled"
        ? event.outcome.status === "answered"
            ? `Reply ready — ${event.body}${event.url === undefined ? "" : `\n${event.url}`}`
            : `Run ended without a reply — ${event.body}${event.outcome.reason === "" ? "" : ` (${event.outcome.reason})`}${event.url === undefined ? "" : `\n${event.url}`}`
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
