/**
 * The in-memory FakeHost (engine-repo tests): implements every
 * `SigrunHost` member the engine uses, in memory. The engine never
 * boots a harness in its own tests — this is the host surface it
 * programs against.
 *
 * - `fake.calls`: the ordered call log (every member method appends
 *   `{ method, args }`), so tests assert WHAT the engine did.
 * - `fake.setClaimed(boolean)`: backs `users.list()`'s length (the
 *   claimed-gate reads `(await users.list()).length === 0`).
 * - `fake.pushView(id, view)`: drives `conversations.watch` listeners.
 * - Interactions: `fake.interactions` keyed `conversationId:callId`.
 *
 * The stores ride a REAL temp dir (settings/secrets get/set are plain
 * file I/O in the real host; keeping that fidelity costs nothing and
 * makes readConfig/JsonFile tests exact).
 *
 * Runtime type imports come from `@sigrun/shared/*` (a devDependency —
 * the same leaf the contract re-exports); `@sigrun/sigrun/extension`
 * stays type-only.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessOf } from "@sigrun/shared/access";
import type { Access, Sharing } from "@sigrun/shared/access";
import type {
	InteractionAnswer,
	InteractionRecord,
} from "@sigrun/shared/interactions";
import type { Principal } from "@sigrun/sigrun/extension";
import type {
	ConversationSummary,
	ConversationViewWire,
	ModelEntry,
	SessionMeta,
	SlashCommand,
	SubmissionRecordWire,
	UserWire as DirectoryUserWire,
} from "@sigrun/shared/views";
import type { AccountLinkWire } from "@sigrun/sigrun/extension";
import type {
	HandlerContext,
	SigrunHost,
	SubmissionInputPart,
	WhenBusyMode,
} from "@sigrun/sigrun/extension";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { SubmissionId } from "@earendil-works/pi-durable";

/** One recorded host call (the ordered log `fake.calls` carries). */
export interface FakeCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

/** What a watch listener registration keeps per conversation. */
interface Watcher {
	readonly id: ConversationId;
	readonly listener: (view: ConversationViewWire) => void;
}

/** FakeHost options: seeded users, claimed state, the stores root. */
export interface FakeHostOptions {
	/** Directory the stores (settings/secrets/paths) root at; a temp dir when absent. */
	readonly storesDir?: string;
	/** Seed users; the claimed gate reads `users.list().length === 0`. */
	readonly users?: readonly { user: string; admin?: boolean }[];
	/** The directory user records (override for richer rows). */
	readonly directory?: readonly DirectoryUserWire[];
	/** Whether setup is claimed (defaults true when any user is seeded). */
	readonly claimed?: boolean;
}

/** The fake host surface: the `SigrunHost` plus the test controls. */
export interface FakeHost extends SigrunHost {
	/** Every host-member call, in order. */
	readonly calls: readonly FakeCall[];
	/** The shared invocation context handlers receive (never aborts). */
	readonly context: HandlerContext;
	/** Set the claimed state (`users.list()`'s length backs the claimed gate). */
	setClaimed(claimed: boolean): void;
	/** Push one view to every `watch` listener of `id`. */
	pushView(id: ConversationId, view: ConversationViewWire): void;
	/** The stored interaction records, keyed `${conversationId}:${callId}`. */
	readonly interactions: ReadonlyMap<string, InteractionRecord>;
	/** The stored conversation metas, keyed id. */
	readonly metas: ReadonlyMap<ConversationId, SessionMeta>;
	/** Tear down the stores dir (call from an afterAll). */
	readonly close: () => Promise<void>;
}

/** The zero abort signal handlers observe (tests never cancel it). */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

const HANDLER_CONTEXT: HandlerContext = { abortSignal: NEVER_ABORTS };

/**
 * Build the fake host (ASYNC: the stores dir is created before the host
 * is usable — the synchronous `paths` getters read the resolved dir).
 * Disposal: `close()` removes the stores dir when the host owned it (a
 * temp dir); a caller-supplied `storesDir` is left in place.
 */
export async function createFakeHost(
	opts: FakeHostOptions = {},
): Promise<FakeHost> {
	const calls: FakeCall[] = [];
	const record = (method: string, ...args: readonly unknown[]): void => {
		calls.push({ method, args });
	};

	const storesDir =
		opts.storesDir ?? (await mkdtemp(join(tmpdir(), "sigrun-gw-fake-host-")));
	// The state root exists before the host is handed out: the engine
	// creates <stateDir>/gateway itself at start, but its PARENT (the
	// scoped state dir) is the store root core ensures — the fake mirrors
	// that so a JsonFile on a deep path never differs.
	await mkdir(join(storesDir, "state"), { recursive: true });

	// The scoped-stores surfaces: a settings JSON object in memory (the
	// real host reads `settings/<slug>.json`; the semantics — absent →
	// {}, set replaces — are what the engine sees).
	let settingsValue: Record<string, unknown> = {};
	const secretsValue: Record<string, string> = {};

	const directory = new Map<string, DirectoryUserWire>(
		(opts.directory ?? (opts.users ?? []).map((entry) => ({
			user: entry.user,
			admin: entry.admin ?? false,
			createdAt: 0,
			source: "cli" as const,
		}))).map((row) => [row.user, row]),
	);
	let claimed = opts.claimed ?? directory.size > 0;

	// Conversations: create/submit/watch/meta/... over plain maps.
	const nextConversationId = { value: 1 };
	const nextSubmissionId = { value: 1 };
	const conversationOwners = new Map<ConversationId, string>();
	const conversationNames = new Map<ConversationId, string>();
	const conversationArchived = new Map<ConversationId, boolean>();
	const submissionsByConversation = new Map<
		ConversationId,
		SubmissionRecordWire[]
	>();
	const watchList: Watcher[] = [];
	const interactions = new Map<string, InteractionRecord>();
	// External account links, keyed `provider:subject` (M3a's surface).
	const accountLinks = new Map<string, AccountLinkWire>();
	const filesByConversation = new Map<
		ConversationId,
		Map<string, { bytes: Uint8Array; mime?: string }>
	>();

	const models: ModelEntry[] = [
		{
			id: "faux/m",
			provider: "faux",
			modelId: "m",
			name: "Faux M",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	];

	const commands: SlashCommand[] = [];

	const emptyMeta = (): SessionMeta => ({
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "gateway",
	});

	const host: SigrunHost = {
		stores: {
			secrets: {
				get: async (key: string) => {
					record("stores.secrets.get", key);
					return secretsValue[key];
				},
				set: async (key: string, value: string) => {
					record("stores.secrets.set", key, value);
					secretsValue[key] = value;
				},
			},
			settings: {
				get: async () => {
					record("stores.settings.get");
					return settingsValue;
				},
				set: async (value: Record<string, unknown>) => {
					record("stores.settings.set", value);
					settingsValue = value;
				},
			},
			paths: {
				// The raw dirs are REAL: the engine's state files land here.
				get data() {
					return join(storesDir, "data");
				},
				get cache() {
					return join(storesDir, "cache");
				},
				get state() {
					return join(storesDir, "state");
				},
			},
		},

		seedInteraction: async (
			conversationId: ConversationId,
			rec: InteractionRecord,
		) => {
			record("seedInteraction", conversationId, rec.callId);
			const key = `${conversationId}:${rec.callId}`;
			const existing = interactions.get(key);
			if (existing !== undefined && existing.status !== "pending") return;
			interactions.set(key, rec);
		},
		answerInteraction: async (
			conversationId: ConversationId,
			callId: string,
			answer: InteractionAnswer,
			context: HandlerContext,
			opts?: { readonly user?: string },
		) => {
			record(
				"answerInteraction",
				conversationId,
				callId,
				answer,
				opts?.user,
			);
			void context;
			const key = `${conversationId}:${callId}`;
			const rec = interactions.get(key);
			if (rec === undefined || rec.status !== "pending") return false;
			interactions.set(key, {
				...rec,
				status: "answered",
				answer,
				answeredBy: "human",
				...(opts?.user === undefined
					? {}
					: { answeredByUser: opts.user }),
			});
			return true;
		},
		settleInteraction: async (
			conversationId: ConversationId,
			callId: string,
			status: "skipped" | "expired" | "cancelled",
		) => {
			record("settleInteraction", conversationId, callId, status);
			const key = `${conversationId}:${callId}`;
			const rec = interactions.get(key);
			if (rec === undefined || rec.status !== "pending") return false;
			interactions.set(key, { ...rec, status });
			return true;
		},
		snapshotInteraction: async (
			conversationId: ConversationId,
			callId: string,
		) => {
			record("snapshotInteraction", conversationId, callId);
			return interactions.get(`${conversationId}:${callId}`);
		},
		setAmbient: async (
			conversationId: ConversationId,
			recordSpec: Parameters<SigrunHost["setAmbient"]>[1],
		) => {
			record("setAmbient", conversationId, recordSpec.key);
		},
		clearAmbient: async (conversationId: ConversationId, key: string) => {
			record("clearAmbient", conversationId, key);
		},

		conversations: {
			create: async (opts: {
				owner?: string;
				name?: string;
				source?: string;
			}) => {
				record("conversations.create", opts);
				const id = nextConversationId.value++ as ConversationId;
				conversationOwners.set(id, opts.owner ?? "tester");
				conversationNames.set(id, opts.name ?? "");
				conversationArchived.set(id, false);
				submissionsByConversation.set(id, []);
				return id;
			},
			submit: async (
				id: ConversationId,
				input: readonly SubmissionInputPart[],
				opts?: {
					user?: string;
					requestId?: string;
					whenBusy?: WhenBusyMode;
				},
			) => {
				record("conversations.submit", id, input, opts);
				const submission: SubmissionRecordWire = {
					id: nextSubmissionId.value++ as SubmissionId,
					conversationId: id,
					...(opts?.requestId === undefined
						? {}
						: { requestId: opts.requestId }),
					type: "pi.user",
					status: "queued",
				};
				submissionsByConversation.get(id)?.push(submission);
				return submission;
			},
			watch: async (
				id: ConversationId,
				listener: (view: ConversationViewWire) => void,
			) => {
				record("conversations.watch", id);
				watchList.push({ id, listener });
				return async () => {
					const index = watchList.findIndex(
						(entry) => entry.id === id && entry.listener === listener,
					);
					if (index !== -1) watchList.splice(index, 1);
				};
			},
			list: async () => {
				record("conversations.list");
				// The fake serves the MINIMAL summary surface the engine reads
				// (id + owner + archive/pin flags); every field is synthesized,
				// so this is not a wire-parity fixture.
				const summaries: ConversationSummary[] = [];
				for (const id of conversationOwners.keys()) {
					summaries.push({
						id,
					root: false,
					owner: conversationOwners.get(id),
					name: conversationNames.get(id),
					source: "gateway",
					archived: conversationArchived.get(id) ?? false,
					pinned: false,
					access: "write",
				});
				}
				return summaries;
			},
			meta: async (id: ConversationId) => {
				record("conversations.meta", id);
				return (
					metas.get(id) ?? {
						...emptyMeta(),
						owner: conversationOwners.get(id),
						name: conversationNames.get(id),
						archived: conversationArchived.get(id) ?? false,
					}
				);
			},
			abort: async (id: ConversationId) => {
				record("conversations.abort", id);
			},
			configure: async (
				id: ConversationId,
				opts: { model?: string; thinking?: unknown },
			) => {
				record("conversations.configure", id, opts);
			},
			compact: async (id: ConversationId) => {
				record("conversations.compact", id);
			},
			fork: async (
				id: ConversationId,
				opts?: { at?: EntryId; owner?: string },
			) => {
				record("conversations.fork", id, opts);
				const child = nextConversationId.value++ as ConversationId;
				conversationOwners.set(child, opts?.owner ?? conversationOwners.get(id) ?? "tester");
				conversationNames.set(child, conversationNames.get(id) ?? "");
				conversationArchived.set(child, false);
				submissionsByConversation.set(child, []);
				return child;
			},
			patchMeta: async (
				id: ConversationId,
				patch: {
					name?: string | null;
					archived?: boolean;
					sharing?: Sharing | null;
				},
			) => {
				record("conversations.patchMeta", id, patch);
				const current =
					metas.get(id) ??
					({
						...emptyMeta(),
						owner: conversationOwners.get(id),
						name: conversationNames.get(id),
					} as SessionMeta);
				const next: SessionMeta = {
					...current,
					...(patch.name === undefined ? {} : { name: patch.name ?? undefined }),
					...(patch.archived === undefined ? {} : { archived: patch.archived }),
				};
				metas.set(id, next);
				conversationArchived.set(id, next.archived);
				return next;
			},
			upload: async (
				id: ConversationId,
				file: { name: string; mime?: string; bytes: Uint8Array },
			) => {
				record("conversations.upload", id, file.name);
				const map =
					filesByConversation.get(id) ?? new Map<string, { bytes: Uint8Array; mime?: string }>();
				filesByConversation.set(id, map);
				const path = `uploads/${id}/${file.name}`;
				map.set(path, { bytes: file.bytes, mime: file.mime });
				return { path };
			},
			readFile: async (id: ConversationId, path: string) => {
				record("conversations.readFile", id, path);
				const file = filesByConversation.get(id)?.get(path);
				if (file === undefined) {
					throw new Error(`fake host: no file at ${path}`);
				}
				return { bytes: file.bytes, mime: file.mime };
			},
		},

		users: {
			list: async () => {
				record("users.list");
				if (!claimed) return [];
				return [...directory.values()];
			},
			get: async (user: string) => {
				record("users.get", user);
				return directory.get(user);
			},
		},

		access: {
			accessOf: async (
				principal: Principal | { readonly user: string },
				resource: { owner?: string; sharing?: Sharing },
			): Promise<Access> => {
				record("access.accessOf", principal, resource);
				return accessOf(
					{
						user: "user" in principal ? principal.user : undefined,
						// The fake has no superusers; the host contract trusts
						// in-process callers, and the engine passes the
						// principal it resolved from the directory.
						superuser: false,
					},
					resource,
				);
			},
		},

		identity: {
			actingUser: async (id: ConversationId) => {
				record("identity.actingUser", id);
				return conversationOwners.get(id);
			},
		},

		// External account links (multi-user M3a): the in-memory table the
		// 0.1.6 contract requires. The engine does not use it yet (the
		// identity store owns chat links); the surface is here so the host
		// shape is whole for the tests that boot it.
		accounts: {
			lookup: async (provider: string, subject: string) => {
				record("accounts.lookup", provider, subject);
				return accountLinks.get(`${provider}:${subject}`);
			},
			link: async (
				provider: string,
				subject: string,
				user: string,
				via: "login" | "self" | "pairing" | "admin",
			) => {
				record("accounts.link", provider, subject, user, via);
				const key = `${provider}:${subject}`;
				const existing = accountLinks.get(key);
				if (existing !== undefined) {
					if (existing.user === user) return existing;
					throw new Error(
						`account_link_conflict: ${provider}/${subject} is already linked`,
				);
				}
				const row: AccountLinkWire = {
					provider,
				subject,
					user,
					linkedAt: 0,
					via,
				};
				accountLinks.set(key, row);
				return row;
			},
			unlink: async (provider: string, subject: string) => {
				record("accounts.unlink", provider, subject);
				return accountLinks.delete(`${provider}:${subject}`);
			},
			listForUser: async (user: string) => {
				record("accounts.listForUser", user);
				return [...accountLinks.values()].filter(
						(row) => row.user === user,
				);
			},
		},

		surfaces: {
			// The engine declares no surfaces (the status route is a route,
			// not a view); the host contract's member exists so the shape
			// is whole.
			changed: (id: string, key: string) => {
				record("surfaces.changed", id, key);
			},
		},

		models: {
			list: async () => {
				record("models.list");
				return models;
			},
		},

		commands: {
			list: async () => {
				record("commands.list");
				return commands;
			},
			run: async (
				id: ConversationId,
				name: string,
				args: string,
				opts: { user: string },
			) => {
				record("commands.run", id, name, args, opts);
				return {};
			},
		},
	};

	// Metas: the map `meta`/`patchMeta` read/write (seeded lazily per
	// conversation from the owner/name records).
	const metas = new Map<ConversationId, SessionMeta>();

	const fake: FakeHost = {
		...host,
		calls,
		context: HANDLER_CONTEXT,
		setClaimed: (value: boolean) => {
			claimed = value;
		},
		pushView: (id: ConversationId, view: ConversationViewWire) => {
			for (const watcher of watchList) {
				if (watcher.id === id) watcher.listener(view);
			}
		},
		interactions,
		metas,
		close: async () => {
			// Only the dir the host OWNED (a temp dir) is removed; a
			// caller-supplied storesDir is the caller's to manage.
			if (opts.storesDir !== undefined) return;
			await rm(storesDir, { recursive: true, force: true });
		},
	};
	return fake;
}
