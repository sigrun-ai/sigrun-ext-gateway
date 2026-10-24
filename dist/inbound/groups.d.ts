/**
 * Group admission and sharing (spec §8.2): group config is consulted for
 * every event, linked identities retain their own sender attribution,
 * and unlinked `anyone` senders act only through the group owner's
 * restricted conversation. Admission is synchronous like `userFor`;
 * Task 13 moves both identity resolutions behind an async interface.
 */
import type { InboundEvent, SigrunHost } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ChannelConfig, GroupConfig } from "../config.js";
import type { IdentityStore } from "../state/identities.js";
/** The terminal result of group admission. */
export type GroupAdmission = {
    readonly admit: false;
    readonly reason: "unlisted" | "failed" | "mention" | "unlinked";
} | {
    readonly admit: true;
    readonly group: GroupConfig;
    /** The linked user, or the group owner for an unlinked sender. */
    readonly user: string;
    readonly linked: boolean;
    readonly senderLabel: string;
};
/** Resolve one event against the channel's current group configuration. */
export declare function admitGroupEvent(config: ChannelConfig, channel: string, event: InboundEvent, identities: IdentityStore): GroupAdmission;
/**
 * Give a linked speaker write access without discarding existing people.
 * The owner already has write access and must not also appear as a guest.
 */
export declare function ensureGroupShare(host: SigrunHost, conversationId: ConversationId, user: string): Promise<void>;
