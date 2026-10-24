/**
 * The inbound pipeline (spec §8.4): one `receive` runs the ordered
 * steps. Task 3 landed steps 2 (dedupe), 3 (self/bot drops), 6 (album
 * merge) and 10 (submit) plus the M12 submit-error outcomes; Task 4
 * fills step 1 (the claimed gate), step 4 (self-link) and step 5 (the
 * DM access policies) INLINE over the shared {@link AccessState} — the
 * access stores are engine-wide (one pairing queue, one link-code
 * table, one token table, one loop guard), so the engine builds the
 * state and hands it to every channel's pipeline. Steps 7 (commands),
 * 8 (interaction answers) and 9 (attachments) remain INJECTABLE STAGES
 * (`PipelineDeps.stages`) filled by their own tasks — the design keeps
 * the step ORDER in one place while each task lands its logic.
 *
 * The channel's config is read LIVE per event by the CALLER (the
 * engine's `receive` wrapper reads `readConfig(host)` and passes the
 * channel's block in) — every field except `enabled` is per-event.
 *
 * On admission the pipeline records `submissionId → { bindingKey,
 * channel }` in `deps.origins` (the in-memory map the outbound tasks
 * consume — which chat a run came from, so settled answers route).
 *
 * The notice/error replies go through `deps.channel.send` — the
 * adapter-bound transport, host-independent (the loopback fixture's
 * `sent` array records them, which is how the sigrun e2e asserts reply
 * text). A failed notice send is logged, never thrown: the submit
 * error already resolved the event's fate.
 */

import { join } from "node:path";
import type {
	ActionEvent,
	ChannelContribution,
	ChatRef,
	InboundEvent,
	OutboundMessage,
	SigrunHost,
	SubmissionInputPart,
	WhenBusyMode,
} from "@sigrun/sigrun/extension";
import type {
	ConversationId,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type { ChannelConfig } from "../config.js";
import type { EngineLog } from "../log.js";
import { buildEnvelope } from "./envelope.js";
import { AlbumCollector, ALBUM_WINDOW_MS } from "./albums.js";
import { bindingKey, BindingStore } from "../state/bindings.js";
import { SeenSet } from "../state/seen.js";
import { IdentityStore } from "../state/identities.js";
import { PairingStore } from "../access/pairing.js";
import { LinkCodes } from "../access/link-codes.js";
import { LoopGuard } from "../access/loop-guard.js";
import { ButtonTokens } from "./tokens.js";
import { normalizeCode } from "../access/codes.js";
import { redeemLink } from "../commands/link.js";
import { approvePairing, denyPairing } from "../commands/pair.js";

/** A receive's terminal outcome (the adapter acks on any resolution). */
export type PipelineOutcome =
	| { readonly outcome: "admitted" }
	| { readonly outcome: "dropped" }
	| { readonly outcome: "command" };

/**
 * The origin record: which chat a submission came from. The outbound
 * tasks (streaming hand-off, unanswered notices) read it.
 */
export interface SubmissionOrigin {
	readonly bindingKey: string;
	readonly channel: string;
}

/**
 * The engine-wide access state (Task 4): every store the access steps
 * and the pair/link commands share. The ENGINE builds one and threads
 * it into every channel pipeline AND the command closures; a pipeline
 * constructed WITHOUT one builds a private state over its own state
 * dir (the stand-alone Task 3 shape).
 */
export interface AccessState {
	readonly identities: IdentityStore;
	readonly pairing: PairingStore;
	readonly linkCodes: LinkCodes;
	readonly tokens: ButtonTokens;
	readonly loopGuard: LoopGuard;
}

/** The stages later tasks inject (§8.4 steps 7, 8, 9). */
export interface PipelineStages {
	/**
	 * Step 7 (commands): handles gateway chat commands (the bound
	 * conversation id is handed in — commands act on it). Returns an
	 * outcome when consumed, undefined to continue.
	 */
	readonly command?: (
		channelId: string,
		event: InboundEvent,
		conversationId: number,
	) => Promise<PipelineOutcome | undefined>;
	/** Step 8 (interaction text answers): consumed-or-continue, as above. */
	readonly interactionAnswer?: (
		channelId: string,
		event: InboundEvent,
	) => Promise<PipelineOutcome | undefined>;
	/** Step 9 (attachments): render the event's media into submit parts. */
	readonly attachments?: (
		event: InboundEvent,
	) => Promise<readonly SubmissionInputPart[]>;
}

/** The pipeline's injectable dependencies. */
export interface PipelineDeps {
	readonly host: SigrunHost;
	/** The channel adapter (send for notice replies; the label for names). */
	readonly channel: ChannelContribution;
	/** The engine's state dir (`<stateDir>/gateway`). */
	readonly stateDir: string;
	readonly log: EngineLog;
	/** submissionId → the origin record (the outbound seam). */
	readonly origins: Map<SubmissionId, SubmissionOrigin>;
	/** The engine-wide binding store (the settled fan-out and the
	 *  delivery workers share this ONE instance — cross-instance writes
	 *  would interleave JsonFile queues and lose updates). Absent → a
	 *  private instance (the stand-alone Task 3 shape). */
	readonly bindings?: BindingStore;
	/** The injectable stages (§8.4 steps 7, 8, 9). */
	readonly stages?: PipelineStages;
	/** The engine-wide access state (Task 4). Absent → a private one. */
	readonly access?: AccessState;
	/** The clock (tests inject a fake). Default: real. */
	readonly now?: () => number;
}

/** The pinned UnservedModelError notice (spec §8.4 M12, exact copy). */
const UNSERVED_MODEL_NOTICE =
	"The model <ref> is not available. Use /model to pick another.";

/** The pinned group refusal for `/link` (spec §8.2, exact copy). */
const LINK_GROUP_REFUSAL = "send this in a direct message";

/** One rendered button row. */
type ButtonRow = readonly {
	readonly label: string;
	readonly data: string;
	readonly style?: "primary" | "danger" | "neutral";
}[];

/**
 * The engine's per-receive handler: `(channelId, event, config) →
 * outcome`. The config is the LIVE channel block (the caller read it
 * per event through `readConfig`).
 */
export type Receive = (
	channelId: string,
	event: InboundEvent,
	config: ChannelConfig,
) => Promise<PipelineOutcome>;

/**
 * A pipeline's receive, carrying the engine-owned flush handle and the
 * tap handler: ONE pipeline per engine (the state stores are shared
 * across channels; the binding key carries the channel) — the engine
 * wires every supervised channel's `ChannelContext.receive` through
 * the callable, calls `flushAlbums` from its `stopIntake`, and routes
 * `ChannelContext.action` through `action`.
 */
export interface PipelineHandle extends Receive {
	/**
	 * Close every open album window and submit its merged batch; the
	 * engine's `stopIntake` runs this before intake closes (the §8.0
	 * ordering: flush, then stop admitting).
	 */
	flushAlbums(): Promise<void>;
	/**
	 * A button tap (§8.7): resolve the token, guard the tapper (a pair
	 * decision needs an EFFECTIVE admin — C8), apply the decision.
	 * Foreign or replayed tokens are ignored; a tap never throws across
	 * the adapter boundary.
	 */
	action(
		channelId: string,
		event: ActionEvent,
		config: ChannelConfig,
	): Promise<void>;
}

/** Build a private access state over `stateDir` (the no-`access` shape). */
function privateAccess(stateDir: string, now: () => number): AccessState {
	return {
		identities: new IdentityStore(join(stateDir, "identities.json")),
		pairing: new PairingStore(join(stateDir, "pairing.json"), { now }),
		linkCodes: new LinkCodes(),
		tokens: new ButtonTokens(),
		loopGuard: new LoopGuard(),
	};
}

export function createPipeline(deps: PipelineDeps): PipelineHandle {
	const now = deps.now ?? Date.now;
	// The engine hands ONE store in (every pipeline, the settled fan-out
	// and the delivery workers share it — cross-instance writes would
	// interleave separate JsonFile queues and lose updates); the
	// stand-alone shape constructs its own.
	const bindings =
		deps.bindings ??
		new BindingStore(join(deps.stateDir, "bindings.json"), { now });
	const seen = new SeenSet(join(deps.stateDir, "seen.json"));
	const access =
		deps.access ??
		privateAccess(deps.stateDir, () => now());
	const albums = new AlbumCollector(now, ALBUM_WINDOW_MS);
	// Per-group close timers (the album window's flush).
	const albumTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// The open groups' submission metadata, keyed by the same timer key:
	// a flush (stopIntake) needs everything a receive would have carried.
	const openAlbums = new Map<
		string,
		{
			channelId: string;
			key: string;
			groupId: string;
			event: InboundEvent;
			user: string;
			conversationId: ConversationId;
			config: ChannelConfig;
		}
	>();

	const receivePipeline: PipelineHandle = async (
		channelId,
		event,
		config,
	): Promise<PipelineOutcome> => {
		const key = bindingKey(channelId, event.chat);
		const seenId = `${key}:${event.messageId}`;

		// Step 1 — the claimed gate (§8.2): an unclaimed deployment has
		// no users to act for; every event drops with ONE log line per
		// channel (the state can flip mid-process — the check is per
		// event, not cached at start).
		if ((await deps.host.users.list()).length === 0) {
			deps.log.once(
				`unclaimed:${channelId}`,
				"warn",
				`setup unclaimed — dropping inbound (channel "${channelId}")`,
			);
			return dropped();
		}

		// Step 2 — dedupe (in-flight-aware: a racing redelivery claims
		// false and drops; an engine failure releases for the retry).
		if (!seen.claim(seenId, now())) {
			return dropped();
		}
		try {
			return await admit(channelId, event, key, config);
		} catch (error) {
			// An unexpected throw is an ENGINE failure: release the seen id
			// (the platform redelivers) and reject — the adapter does not
			// ack, so the message is retried rather than lost.
			seen.release(seenId);
			throw error;
		}
	};

	/** The pipeline past the dedupe claim. */
	async function admit(
		channelId: string,
		event: InboundEvent,
		key: string,
		config: ChannelConfig,
	): Promise<PipelineOutcome> {
		// Step 3 — self and bot drops. An ADMITTED bot rides the loop
		// guard (§8.2: 10 per chat per 60000 ms, then a 300000 ms
		// cooldown) — a chatty integration must never monopolize the run
		// queue or echo itself into a loop.
		if (event.fromSelf === true) return dropped();
		if (event.sender.isBot === true) {
			if (!config.allowBots) return dropped();
			if (!access.loopGuard.admit(key, now())) {
				deps.log.once(
					`loop-guard:${key}`,
					"warn",
					"bot loop guard tripped — bot messages on this chat drop for 5 minutes",
				);
				return dropped();
			}
		}

		// Step 4 — self-link (`/link <code>`, §8.2): handled BEFORE
		// access — the code IS the authorization, so the sender may be
		// unknown here. Only when the channel's `selfLink` is on; a
		// selfLink-off channel leaves `/link` to the access policy (an
		// allowlist channel's operator chose a closed list).
		if (config.selfLink && isLinkCommand(event.text)) {
			if (event.chat.chatType !== "dm") {
				// The code was exposed to other members (M9): void it, then
				// refuse. The refusal is exact (the plan pins the string).
				access.linkCodes.invalidate(
					normalizeCode(event.text.replace(/^\/link\s*/, "")),
				);
				await sendNotice(event.chat, LINK_GROUP_REFUSAL, undefined);
				return { outcome: "command" };
			}
			const reply = await redeemLink(
				{
					identities: access.identities,
					linkCodes: access.linkCodes,
					log: deps.log,
					now,
				},
				channelId,
				event,
			);
			await sendNotice(event.chat, reply, undefined);
			return { outcome: "command" };
		}

		// Step 5 — access (§8.2). DMs resolve through the allowlist then
		// links; an unknown DM sender's treatment follows the channel's
		// `dm` policy. Groups arrive with Task 8's admission stage;
		// everything else drops.
		if (event.chat.chatType !== "dm") {
			return dropped();
		}
		const resolved = access.identities.userFor(
			config,
			channelId,
			event.sender.id,
		);
		if (resolved === undefined) {
			return await unknownDm(channelId, event, config);
		}

		// The bound conversation, or a fresh one for an unbound chat.
		const binding = bindings.get(key);
		if (binding?.dead) {
			await bindings.clearDead(key);
		}
		let conversationId: ConversationId;
		if (binding === undefined) {
			conversationId = (await deps.host.conversations.create({
				owner: resolved.user,
				source: "gateway",
				name: event.chat.title ?? `${deps.channel.label} DM`,
			})) as ConversationId;
			await bindings.bind(key, conversationId, event.chat);
		} else {
			conversationId = binding.conversationId as ConversationId;
			// An archived conversation unarchives before submit (spec
			// §8.3's my-call: archiving never silently breaks a chat).
			const meta = await deps.host.conversations.meta(conversationId);
			if (meta.archived) {
				await deps.host.conversations.patchMeta(conversationId, {
					archived: false,
				});
			}
		}

		// Step 7 — commands (injected; Task 7 fills).
		const command = await deps.stages?.command?.(
			channelId,
			event,
			conversationId,
		);
		if (command !== undefined) {
			await seen.commit(`${key}:${event.messageId}`, now());
			return command;
		}

		// Step 8 — interaction text answers (injected; Task 9 fills).
		const interaction = await deps.stages?.interactionAnswer?.(
			channelId,
			event,
		);
		if (interaction !== undefined) {
			await seen.commit(`${key}:${event.messageId}`, now());
			return interaction;
		}

		// Step 6 — the album merge: a group's events become ONE
		// submission when the window closes; a plain event is its own.
		const envelopeText = buildEnvelope(event, {
			group: false,
			senderLabel: event.sender.name ?? event.sender.id,
		});
		const batch = albums.add(key, event, envelopeText);
		if (batch === undefined) {
			// Collecting: commit seen NOW (the events ARE admitted — a
			// platform redelivery of a held sibling is a no-op) and arm
			// the close timer that submits the merged batch.
			await seen.commit(`${key}:${event.messageId}`, now());
			scheduleAlbumClose(
				channelId,
				key,
				event,
				resolved.user,
				conversationId,
				config,
			);
			return { outcome: "admitted" };
		}

		// Step 10 — submit.
		return await submit(channelId, event, key, conversationId, resolved.user, batch, config);
	}

	/** Step 5's unknown-DM branch: the channel's `dm` policy (§8.2). */
	async function unknownDm(
		channelId: string,
		event: InboundEvent,
		config: ChannelConfig,
	): Promise<PipelineOutcome> {
		if (config.dm === "disabled") {
			// Silent: no reply, no log (the operator turned DMs off —
			// a log line per stranger would be noise, not signal).
			return dropped();
		}
		if (config.dm === "allowlist") {
			// Drop, logged once per sender per day (the day bucket in the
			// key; a restart re-logs once — the honest per-process bound).
			const day = Math.floor(now() / 86_400_000);
			deps.log.once(
				`dm-drop:${channelId}:${event.sender.id}:${day}`,
				"warn",
				`dm from unknown sender dropped (channel "${channelId}")`,
			);
			return dropped();
		}
		// `pairing`: one request, one reply carrying the code, admin
		// notices — and the message itself is NEVER submitted, then or
		// after approval (§8.2).
		const result = access.pairing.request(
			channelId,
			{ id: event.sender.id, name: event.sender.name },
			event.chat,
			now(),
		);
		if ("limited" in result) {
			// No reply on a limit (§8.2): a reply would be an oracle for a
			// probing sender. The drop is logged once per sender.
			deps.log.once(
				`pairing-limited:${channelId}:${event.sender.id}`,
				"info",
				`pairing request over limit (${result.limited}, channel "${channelId}")`,
			);
			return dropped();
		}
		await sendNotice(
			event.chat,
			`Your pairing code is ${result.code}. An admin will approve it — ` +
				"until then your messages are not processed.",
			undefined,
		);
		await notifyAdmins(channelId, event, result.code, config);
		return dropped();
	}

	/** The pairing notice to every effective admin's home DM (§8.2). */
	async function notifyAdmins(
		channelId: string,
		event: InboundEvent,
		code: string,
		config: ChannelConfig,
	): Promise<void> {
		void config;
		const users = await deps.host.users.list();
		const admins = users.filter(
			(row) => row.admin === true || row.groupAdmin === true,
		);
		if (admins.length === 0) return;
		const who = event.sender.name ?? event.sender.id;
		const text =
			`Pairing request from ${who} on ${deps.channel.label}.\n` +
			`/pair approve ${code} <user>\n` +
			`/pair deny ${code}`;
		// Buttons when they fit: one "Approve as <user>" per DIRECTORY
		// user plus Deny, within `buttons.max` (the max-1 bound leaves
		// room for the Deny row entry). Too many users → text only.
		const caps = deps.channel.capabilities.buttons;
		const rows: readonly ButtonRow[] | undefined =
			caps === undefined || users.length > caps.max - 1
				? undefined
				: [
						[
							...users.map((row) => ({
								label: `Approve as ${row.user}`,
								data: access.tokens.issue({
									kind: "pair",
									code,
									decision: "approve",
									user: row.user,
								}),
								style: "primary" as const,
							})),
							{
								label: "Deny",
								data: access.tokens.issue({
									kind: "pair",
									code,
									decision: "deny",
								}),
								style: "danger" as const,
							},
						],
					];
		for (const admin of admins) {
			// §8.8: an admin's home chats are always DMs; the notice rides
			// THIS channel's adapter, so only this channel's homes get it.
			for (const home of access.identities.homesOf(admin.user)) {
				if (home.channel !== channelId) continue;
				await sendNotice(home.chat, text, rows);
			}
		}
	}

	/** Step 10: the submit + the M12 error outcomes. */
	async function submit(
		channelId: string,
		event: InboundEvent,
		key: string,
		conversationId: ConversationId,
		user: string,
		batch: readonly string[],
		config: ChannelConfig,
	): Promise<PipelineOutcome> {
		const text = batch.join("\n");
		const parts: SubmissionInputPart[] = [
			...(deps.stages?.attachments === undefined
				? []
				: await deps.stages.attachments(event)),
			{ type: "text", text },
		];
		const opts: {
			user: string;
			requestId: string;
			whenBusy: WhenBusyMode;
		} = {
			user,
			requestId: `${key}:${event.messageId}`,
			whenBusy: config.busy,
		};
		try {
			const record = await deps.host.conversations.submit(
				conversationId,
				parts,
				opts,
			);
			await seen.commit(`${key}:${event.messageId}`, now());
			deps.origins.set(record.id as SubmissionId, {
				bindingKey: key,
				channel: channelId,
			});
			return { outcome: "admitted" };
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "UnservedModelError"
			) {
				// The pinned notice with the ref interpolated (M12). Named
				// by `name`, never `instanceof` across the types-only
				// contract (the error class ships in sigrun's runtime, not
				// the extension types).
				const ref = unservedModelRef(error);
				// Commit seen BEFORE the notice: the idempotency record
				// must be durable before the fallible network write — a
				// commit failure after a sent notice would make the
				// platform redeliver into a duplicate submit + duplicate
				// notice.
				await seen.commit(`${key}:${event.messageId}`, now());
				await sendNotice(
					event.chat,
					UNSERVED_MODEL_NOTICE.replace("<ref>", ref),
					undefined,
				);
				return dropped();
			}
			if (
				error instanceof Error &&
				error.name === "ConversationOpError"
			) {
				// A short notice + the error code logged (M12).
				const code = conversationOpCode(error);
				deps.log.error(
					`submit failed (conversation ${String(conversationId)}, code "${code}")`,
					error,
				);
				// Commit seen BEFORE the notice (the same ordering as the
				// UnservedModelError branch: idempotency first, network second).
				await seen.commit(`${key}:${event.messageId}`, now());
				await sendNotice(
					event.chat,
					"Could not deliver that message. Try again in a moment.",
					undefined,
				);
				return dropped();
			}
			throw error;
		}
	}

	/** Send one notice reply through the adapter (errors logged, never thrown). */
	async function sendNotice(
		chat: ChatRef,
		text: string,
		buttons: readonly ButtonRow[] | undefined,
	): Promise<void> {
		const message: OutboundMessage = {
			chat,
			text,
			...(buttons === undefined ? {} : { buttons }),
		};
		try {
			await deps.channel.send(message);
		} catch (error) {
			deps.log.error("notice send failed", error);
		}
	}

	/** Arm the album-close timer for a collecting group (one per group). */
	function scheduleAlbumClose(
		channelId: string,
		key: string,
		event: InboundEvent,
		user: string,
		conversationId: ConversationId,
		config: ChannelConfig,
	): void {
		if (event.groupId === undefined) return;
		const timerKey = `${key}:${event.groupId}`;
		if (albumTimers.has(timerKey)) return;
		openAlbums.set(timerKey, {
			channelId,
			key,
			groupId: event.groupId,
			event,
			user,
			conversationId,
			config,
		});
		const timer = setTimeout(() => {
			albumTimers.delete(timerKey);
			openAlbums.delete(timerKey);
			const texts = albums.close(key, event.groupId ?? "");
			if (texts.length === 0) return;
			void submit(channelId, event, key, conversationId, user, texts, config)
				.catch((error: unknown) => {
					// The timer path has no receive to reject: an unexpected
					// throw logs loud (the album's events are committed seen;
					// the M12 classes already resolved their own outcome).
					deps.log.error("album submit failed", error);
				});
		}, ALBUM_WINDOW_MS);
		albumTimers.set(timerKey, timer);
	}

	/**
	 * Flush every open album window NOW and submit its merged batch —
	 * the engine's `stopIntake` calls this so a shutdown inside the
	 * 1500 ms window never loses a collected album (its events are
	 * already committed seen; without this flush the platform's
	 * redelivery would be a dedupe no-op, permanently dropping them).
	 *
	 * Every submission settles before this resolves; an unexpected
	 * throw on one album is logged (the flush still drains the rest —
	 * one failed album must not strand the others at shutdown).
	 */
	async function flushAlbums(): Promise<void> {
		for (const timer of albumTimers.values()) clearTimeout(timer);
		albumTimers.clear();
		const pending = [...openAlbums.values()];
		openAlbums.clear();
		await Promise.all(
			pending.map(async (album) => {
				const texts = albums.close(album.key, album.groupId);
				if (texts.length === 0) return;
				try {
					await submit(
						album.channelId,
						album.event,
						album.key,
						album.conversationId,
						album.user,
						texts,
						album.config,
					);
				} catch (error) {
					deps.log.error("album flush submit failed", error);
				}
			}),
		);
	}

	// The tap handler (§8.7 button tokens): a pair decision needs an
	// EFFECTIVE admin tapper (C8) — the tapper's platform identity maps
	// through the same allowlist/links, then the directory record's
	// admin flag or group grant decides. Everything else resolves
	// quietly: a replayed/foreign token, an unknown sender, a plain
	// user. The requester's "linked" notice rides `approvePairing`.
	async function pipelineAction(
		channelId: string,
		event: ActionEvent,
		config: ChannelConfig,
	): Promise<void> {
		const action = access.tokens.resolve(event.data);
		if (action === undefined || action.kind !== "pair") return;
		const tapper = access.identities.userFor(
			config,
			channelId,
			event.sender.id,
		);
		if (tapper === undefined) {
			deps.log.once(
				`tap-unknown:${channelId}:${event.sender.id}`,
				"warn",
				"pairing button tap from an unknown sender ignored",
			);
			return;
		}
		const record = await deps.host.users.get(tapper.user);
		if (record === undefined || (record.admin !== true && record.groupAdmin !== true)) {
			deps.log.once(
				`tap-not-admin:${channelId}:${tapper.user}`,
				"warn",
				`pairing button tap by non-admin "${tapper.user}" ignored`,
			);
			return;
		}
		const pairDeps = {
			host: deps.host,
			identities: access.identities,
			pairing: access.pairing,
			channelOf: (id: string): ChannelContribution | undefined =>
				id === channelId ? deps.channel : undefined,
			log: deps.log,
			now,
		};
		if (action.decision === "deny") {
			await denyPairing(pairDeps, action.code);
			return;
		}
		if (action.user === undefined) return;
		await approvePairing(pairDeps, action.code, action.user);
	}

	// The flush + tap handles ride the returned receive function
	// (properties, not a separate return shape — the engine holds the
	// same callable it wires into every adapter's context).
	receivePipeline.flushAlbums = flushAlbums;
	receivePipeline.action = pipelineAction;
	return receivePipeline;
}

/** Is `text` a `/link` invocation (with or without an argument)? */
function isLinkCommand(text: string): boolean {
	return text === "/link" || text.startsWith("/link ");
}

/** Extract the `provider/modelId` ref from an UnservedModelError-like. */
function unservedModelRef(error: Error): string {
	const ref = (
		error as {
			readonly ref?: { readonly provider?: string; readonly modelId?: string };
		}
	).ref;
	if (ref?.provider !== undefined && ref.modelId !== undefined) {
		return `${ref.provider}/${ref.modelId}`;
	}
	return "the configured model";
}

/** Extract the error code from a ConversationOpError-like. */
function conversationOpCode(error: Error): string {
	const body = (error as { readonly body?: { readonly error?: string } })
		.body;
	return body?.error ?? error.message;
}

/** The dropped outcome. */
function dropped(): PipelineOutcome {
	return { outcome: "dropped" };
}
