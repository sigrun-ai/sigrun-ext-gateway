/**
 * Group admission and sharing (spec §8.2): group config is consulted for
 * every event, linked identities retain their own sender attribution,
 * and unlinked `anyone` senders act only through the group owner's
 * restricted conversation. Identity resolution reads core's link table.
 */
/** Resolve one event against the channel's current group configuration. */
export async function admitGroupEvent(config, channel, event, identities) {
    const row = config.groups.find((group) => group.chat === event.chat.chatId);
    if (row === undefined)
        return { admit: false, reason: "unlisted" };
    if ("failed" in row)
        return { admit: false, reason: "failed" };
    if (row.mention === "required" && event.mentioned !== true) {
        return { admit: false, reason: "mention" };
    }
    const resolved = await identities.userFor(config, channel, event.sender.id);
    if (resolved === undefined && row.members === "linked") {
        return { admit: false, reason: "unlinked" };
    }
    if (resolved === undefined) {
        return {
            admit: true,
            group: row,
            user: row.owner,
            linked: false,
            senderLabel: `${event.sender.name ?? event.sender.id} (not linked)`,
        };
    }
    return {
        admit: true,
        group: row,
        user: resolved.user,
        linked: true,
        // The pipeline replaces this platform fallback with the directory
        // display name when the directory supplies one.
        senderLabel: event.sender.name ?? resolved.user,
    };
}
/**
 * Give a linked speaker write access without discarding existing people.
 * The owner already has write access and must not also appear as a guest.
 */
export async function ensureGroupShare(host, conversationId, user) {
    const meta = await host.conversations.meta(conversationId);
    if (meta.owner === user)
        return;
    const sharing = meta.sharing;
    if (sharing?.scope === "people" && sharing.users.includes(user))
        return;
    const users = sharing?.scope === "people" ? [...sharing.users, user] : [user];
    await host.conversations.patchMeta(conversationId, {
        sharing: { scope: "people", users, level: "write" },
    });
}
