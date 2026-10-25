/**
 * The `/pair` command (spec §8.2): the admin surface for pending
 * pairing requests, runnable from any webui/TUI conversation through
 * the extension-command invoke route (`POST /v1/conversations/:id/
 * commands/pair`) — and, through the same decision functions, from
 * chat via the pairing-notice buttons (§8.2: every admin's home DM
 * gets the request; the buttons carry opaque tokens the pipeline
 * resolves).
 *
 * Admin-only (EFFECTIVE admin — the caller's principal carries it from
 * the stored flag OR the persisted group grant, C8). An unnamed caller
 * (the no-auth loopback method) is refused with the pinned
 * "run this as a named user".
 *
 * `approve <code> <user>` links the REQUESTER (the platform sender who
 * asked to pair) to the named directory user via the identity store
 * (`via: "pairing"`), sets their DM as the home chat, and sends them a
 * "linked" message through their channel. Core refuses a sender already
 * linked to another user; the request then stays pending for an admin
 * to resolve (deny, or remove the link).
 */

import type { ChannelContribution } from "@sigrun/sigrun/extension";
import type { EngineLog } from "../log.js";
import type { IdentityStore } from "../state/identities.js";
import type { PairingStore } from "../access/pairing.js";
import { normalizeCode } from "../access/codes.js";

/** The `/pair` decision path's runtime dependencies (the engine wires them). */
export interface PairDeps {
	/** The host: the directory the approved user must exist in. */
	readonly host: {
		readonly users: {
			list(): Promise<readonly { readonly user: string }[]>;
		};
	};
	readonly identities: IdentityStore;
	readonly pairing: PairingStore;
	/**
	 * The channel adapter for `channelOf(id)` — the "linked" reply rides
	 * the requester's own channel (undefined: the channel went away; the
	 * reply is skipped, the link still lands).
	 */
	readonly channelOf: (
		channel: string,
	) => ChannelContribution | undefined;
	readonly log: EngineLog;
	readonly now: () => number;
}

/** Who invoked the command. */
export interface PairCaller {
	readonly user: string | undefined;
	readonly admin: boolean;
}

/** The pinned refusal for an unnamed caller (spec §8.2). */
export const UNNAMED_CALLER = "run this as a named user";

/** The pinned conflict reply (spec §8.2: never silently re-pointed). */
export const PAIR_CONFLICT_REPLY =
	"That sender is already linked to another user.";

/** The usage line (the args grammar, one line). */
const USAGE = "usage: /pair [approve <code> <user> | deny <code>]";

/**
 * Run `/pair` with `args` as `caller`. Every path resolves a string
 * reply (the command's notice); nothing throws across the boundary.
 */
export async function runPair(
	deps: PairDeps,
	args: string,
	caller: PairCaller,
): Promise<string> {
	if (caller.user === undefined) return UNNAMED_CALLER;
	if (!caller.admin) {
		return "only admins can manage pairing requests.";
	}
	const parts = args.trim().split(/\s+/).filter((part) => part !== "");
	if (parts.length === 0) return listPending(deps);
	const verb = parts[0];
	if (verb === "deny" && parts.length === 2) {
		return denyPairing(deps, normalizeCode(parts[1] ?? ""));
	}
	if (verb === "approve" && parts.length === 3) {
		return approvePairing(deps, normalizeCode(parts[1] ?? ""), parts[2] ?? "");
	}
	return USAGE;
}

/** `""` — one line per pending request (channel, sender, code, age). */
function listPending(deps: PairDeps): string {
	const now = deps.now();
	const rows = deps.pairing.pending();
	if (rows.length === 0) return "no pending pairing requests.";
	return rows
		.map((row) => {
			const minutes = Math.max(0, Math.round((now - row.createdAt) / 60_000));
			const who = row.senderName === undefined ? row.senderId : row.senderName;
			return `${row.channel}: ${who} — /pair approve ${row.code} <user> (${minutes}m ago)`;
		})
		.join("\n");
}

/**
 * Apply `deny <code>` (the command and the button share this path).
 * Returns the decision reply for the admin surface.
 */
export function denyPairing(deps: PairDeps, code: string): string {
	if (deps.pairing.deny(code)) return `pairing request ${code} denied.`;
	return `unknown pairing code ${code}.`;
}

/**
 * Apply `approve <code> <user>` (the command and the "Approve as"
 * buttons share this path): directory check, core-backed link, then
 * consume the queue row and send the requester's "linked" message.
 * Core's conflict refusal leaves the request pending.
 */
export async function approvePairing(
	deps: PairDeps,
	code: string,
	namedUser: string,
): Promise<string> {
	const directory = await deps.host.users.list();
	if (!directory.some((row) => row.user === namedUser)) {
		return `unknown user ${namedUser}.`;
	}
	// The pre-approve read: find the row WITHOUT consuming it.
	const request = deps.pairing.pending().find((row) => row.code === code);
	if (request === undefined) {
		return `unknown pairing code ${code}.`;
	}
	const linked = await deps.identities.link(
		request.channel,
		request.senderId,
		namedUser,
		"pairing",
		request.chat,
	);
	if (!linked.linked) return PAIR_CONFLICT_REPLY;
	deps.pairing.approve(code, deps.now());
	deps.log.info(
		`pairing approved on channel "${request.channel}" for user "${namedUser}"`,
	);
	const channel = deps.channelOf(request.channel);
	if (channel !== undefined) {
		try {
			await channel.send({
				chat: request.chat,
				text: `You are linked to sigrun as ${namedUser}.`,
			});
		} catch (error) {
			// The link landed; the celebratory notice is best-effort (a
			// down channel never rolls back an approval).
			deps.log.error("pairing linked-notice send failed", error);
		}
	}
	return `linked ${request.senderName ?? request.senderId} to ${namedUser}.`;
}
