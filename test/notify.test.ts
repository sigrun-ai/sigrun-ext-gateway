/**
 * Home-chat notifier (spec §8.8): unbound reply notices and failed-job
 * notices enqueue to the recipient's home DMs; bound replies do not
 * duplicate the settled answer.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { NotificationEvent } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/views";
import { createNotifier, type NotifyDeps } from "../src/notify.js";
import { BindingStore, bindingKey } from "../src/state/bindings.js";
import { IdentityStore } from "../src/state/identities.js";
import { Ledger } from "../src/state/ledger.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { parseGatewayConfig, type GatewayConfig } from "../src/config.js";
import type { EngineLog } from "../src/log.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const LOG: EngineLog = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	once: () => {},
};

interface Rig {
	readonly host: FakeHost;
	readonly bindings: BindingStore;
	readonly ledger: Ledger;
	readonly deps: NotifyDeps;
	readonly setNotifyHome: (home: boolean) => void;
}

async function rig(): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-notify-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const host = await createFakeHost({ storesDir: dir, users: [{ user: "alice" }] });
	const bindings = new BindingStore(join(dir, "bindings.json"));
	const identities = new IdentityStore(host, join(dir, "identities.json"));
	await identities.link(
		"loop",
		"100000001",
		"alice",
		"pairing",
		{ chatId: "100000001", chatType: "dm" },
	);
	const ledger = new Ledger(join(dir, "ledger.json"));
	let config: GatewayConfig = parseGatewayConfig({});
	return {
		host,
		bindings,
		ledger,
		deps: {
			host,
			bindings,
			identities,
			ledger,
			readConfig: async () => config,
			log: LOG,
		},
		setNotifyHome: (home) => {
			config = parseGatewayConfig({ notify: { home } });
		},
	};
}

function settled(over: Partial<Extract<NotificationEvent, { type: "run.settled" }>> = {}): NotificationEvent {
	return {
		type: "run.settled",
		conversationId: 7,
		user: "alice",
		title: "Reply ready",
		body: "Nightly report",
		outcome: { status: "answered" },
		...over,
	};
}

describe("home-chat notifier", () => {
	test("an unbound run.settled enqueues the named notice and event link", async () => {
		const { ledger, deps } = await rig();
		await createNotifier(deps).notify(
			settled({ url: "https://sigrun.example.invalid/#/c/7" }),
			{ host: deps.host },
		);
		expect(ledger.nextPending("loop")?.message).toEqual({
			chat: { chatId: "100000001", chatType: "dm" },
			text: "Reply ready — Nightly report\nhttps://sigrun.example.invalid/#/c/7",
		});
	});

	test("a job-run settle does not duplicate its delivery with Reply ready", async () => {
		const { host, ledger, deps } = await rig();
		const id = await host.conversations.create({ owner: "alice", name: "Nightly report" });
		const meta = await host.conversations.meta(id);
		(host.metas as Map<ConversationId, SessionMeta>).set(id, {
			...meta,
			jobId: "api:nightly",
			deliver: ["loop"],
		});
		await createNotifier(deps).notify(settled({ conversationId: id as number }), {
			host: deps.host,
		});
		expect(ledger.nextPending("loop")).toBeUndefined();
	});

	test("a later run in the same unbound conversation gets its own notice", async () => {
		const { ledger, deps } = await rig();
		const notifier = createNotifier(deps);
		await notifier.notify(settled({ body: "First reply" }), { host: deps.host });
		const first = ledger.nextPending("loop");
		await ledger.mark(first!.id, "delivered");
		await notifier.notify(settled({ body: "Second reply" }), { host: deps.host });
		expect(ledger.nextPending("loop")?.message.text).toBe("Reply ready — Second reply");
	});

	// F6: a DEAD binding must not suppress the unbound home notice —
	// the settled fan-out skips dead bindings, so counting them here
	// would drop the answer with no log.
	test("a conversation whose only binding is dead still gets the home notice", async () => {
		const { bindings, ledger, deps } = await rig();
		const chat = { chatId: "200000002", chatType: "dm" } as const;
		const key = bindingKey("loop", chat);
		await bindings.bind(key, 7, chat);
		await bindings.markDead(key);
		await createNotifier(deps).notify(settled(), { host: deps.host });
		expect(ledger.nextPending("loop")?.message.text).toContain("Reply ready");
	});

	test("a bound run.settled enqueues nothing", async () => {
		const { bindings, ledger, deps } = await rig();
		const chat = { chatId: "200000002", chatType: "dm" } as const;
		await bindings.bind(bindingKey("loop", chat), 7, chat);
		await createNotifier(deps).notify(settled(), { host: deps.host });
		expect(ledger.nextPending("loop")).toBeUndefined();
	});

	test("notify.home false disables home notices", async () => {
		const { ledger, deps, setNotifyHome } = await rig();
		setNotifyHome(false);
		await createNotifier(deps).notify(settled(), { host: deps.host });
		expect(ledger.nextPending("loop")).toBeUndefined();
	});

	test("job.failed uses the event recipient's home DMs", async () => {
		const { ledger, deps } = await rig();
		await createNotifier(deps).notify(
			{
				type: "job.failed",
				conversationId: 7,
				jobId: "api:nightly",
				user: "alice",
				title: "Job nightly failed",
				body: "faux provider failure",
			},
			{ host: deps.host },
		);
		expect(ledger.nextPending("loop")?.message.text).toBe(
			"Job nightly failed\nfaux provider failure",
		);
	});

	test("an unanswered run with a reason enqueues a truthful non-success notice", async () => {
		const { ledger, deps } = await rig();
		await createNotifier(deps).notify(
			settled({
				title: "Run ended without a reply",
				body: "Nightly report — model_error: faux provider failure",
				outcome: { status: "unanswered", reason: "model_error: faux provider failure" },
			}),
			{ host: deps.host },
		);
		const text = ledger.nextPending("loop")?.message.text;
		expect(text).toContain("model_error: faux provider failure");
		expect(text).not.toContain("Reply ready");
		expect(text).toContain("Nightly report");
	});

	test("an unanswered run with an EMPTY reason still never says Reply ready", async () => {
		const { ledger, deps } = await rig();
		await createNotifier(deps).notify(
			settled({
				title: "Run ended without a reply",
				body: "Nightly report — ",
				outcome: { status: "unanswered", reason: "" },
			}),
			{ host: deps.host },
		);
		const text = ledger.nextPending("loop")?.message.text;
		expect(text).toBeDefined();
		expect(text).not.toContain("Reply ready");
		expect(text).toContain("Run ended without a reply");
	});

	test("an event without a recipient enqueues nothing", async () => {
		const { ledger, deps } = await rig();
		await createNotifier(deps).notify(settled({ user: undefined }), {
			host: deps.host,
		});
		expect(ledger.nextPending("loop")).toBeUndefined();
	});
});
