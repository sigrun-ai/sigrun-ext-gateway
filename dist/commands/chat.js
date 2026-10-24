/**
 * Chat commands (spec §8.5): the gateway's reserved slash commands plus
 * non-colliding extension commands. They run inline at inbound stage 7,
 * before the busy submission queue, and every operation acts on the
 * chat's current binding.
 *
 * Unknown slash text is NOT consumed: prompt templates and skill
 * expansion still belong to ordinary submission admission. `/link` and
 * `/pair` are the authorization exceptions — linking needs no existing
 * conversation access, and pairing applies its own effective-admin
 * check. Every other command first proves write access to the bound
 * conversation; `/attach` then separately proves write access to its
 * target before changing the binding.
 */
import { redeemLink } from "./link.js";
import { runPair } from "./pair.js";
/** The reserved command table, in spec §8.5 order. */
export const GATEWAY_COMMANDS = [
    { name: "new", description: "Start a fresh conversation and bind this chat to it", where: "any" },
    { name: "stop", description: "Stop the live run", where: "any" },
    { name: "model", description: "Show or change the conversation model", where: "any" },
    { name: "thinking", description: "Show or change the thinking level", where: "any" },
    { name: "compact", description: "Compact this conversation's history", where: "any" },
    { name: "attach", description: "Bind this chat to an existing conversation", where: "not-anyone-group" },
    { name: "status", description: "Show this chat's conversation status", where: "any" },
    { name: "home", description: "Make this DM your home chat on this channel", where: "dm" },
    { name: "link", description: "Link this chat account with a single-use code", where: "dm" },
    { name: "pair", description: "Manage pending pairing requests (admin)", where: "dm", admin: true },
    { name: "help", description: "List gateway and extension commands", where: "any" },
];
const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/** The native menu: reserved commands plus non-colliding extension rows. */
export async function chatCommandMenu(host) {
    const extensions = await extensionCommands(host);
    return [
        ...GATEWAY_COMMANDS.map(({ name, description }) => ({ name, description })),
        ...extensions.map(({ name, description }) => ({ name, description })),
    ];
}
/**
 * Consume one gateway/extension command, or return `"not-a-command"`
 * so admission continues with the original text.
 */
export async function handleChatCommand(deps, ctx) {
    const parsed = parseCommand(ctx.event.text);
    if (parsed === undefined)
        return "not-a-command";
    const gateway = GATEWAY_COMMANDS.find((command) => command.name === parsed.name);
    if (gateway === undefined) {
        const extension = (await extensionCommands(deps.host)).find((command) => command.name === parsed.name);
        if (extension === undefined)
            return "not-a-command";
        if (!(await hasBoundWriteAccess(deps, ctx))) {
            await reply(deps, ctx, "You do not have write access to this conversation.");
            return "command";
        }
        if (ctx.user === undefined || ctx.binding === undefined) {
            await reply(deps, ctx, "You do not have write access to this conversation.");
            return "command";
        }
        const result = await deps.host.commands.run(ctx.binding.conversationId, extension.name, parsed.args, { user: ctx.user });
        if (result.notice !== undefined && result.notice !== "") {
            await reply(deps, ctx, result.notice);
        }
        return "command";
    }
    if (gateway.where === "dm" && ctx.event.chat.chatType !== "dm") {
        await reply(deps, ctx, "send this in a direct message");
        return "command";
    }
    if (gateway.where === "not-anyone-group" && ctx.group?.members === "anyone") {
        await reply(deps, ctx, "/attach is not available in this group.");
        return "command";
    }
    if (gateway.name !== "link" && gateway.name !== "pair") {
        if (!(await hasBoundWriteAccess(deps, ctx))) {
            await reply(deps, ctx, "You do not have write access to this conversation.");
            return "command";
        }
    }
    switch (gateway.name) {
        case "new":
            await newConversation(deps, ctx);
            break;
        case "stop":
            await stopRun(deps, ctx);
            break;
        case "model":
            await configureModel(deps, ctx, parsed.args);
            break;
        case "thinking":
            await configureThinking(deps, ctx, parsed.args);
            break;
        case "compact":
            await requireBinding(deps, ctx, async (conversationId) => {
                await deps.host.conversations.compact(conversationId);
                await reply(deps, ctx, "Compaction queued.");
            });
            break;
        case "attach":
            await attachConversation(deps, ctx, parsed.args);
            break;
        case "status":
            await showStatus(deps, ctx);
            break;
        case "home":
            if (ctx.user !== undefined) {
                await deps.identities.setHome(ctx.user, ctx.channel, ctx.event.chat);
                await reply(deps, ctx, "This DM is now your home chat on this channel.");
            }
            break;
        case "link": {
            const notice = await redeemLink({
                identities: deps.identities,
                linkCodes: deps.linkCodes,
                log: deps.log,
                now: deps.now,
            }, ctx.channel, { ...ctx.event, text: `/link ${parsed.args}` });
            await reply(deps, ctx, notice);
            break;
        }
        case "pair": {
            const record = ctx.user === undefined
                ? undefined
                : await deps.host.users.get(ctx.user);
            const notice = await runPair({
                host: deps.host,
                identities: deps.identities,
                pairing: deps.pairing,
                channelOf: deps.channelOf,
                log: deps.log,
                now: deps.now,
            }, parsed.args, {
                user: ctx.user,
                admin: record?.admin === true || record?.groupAdmin === true,
            });
            await reply(deps, ctx, notice);
            break;
        }
        case "help": {
            const menu = await chatCommandMenu(deps.host);
            await reply(deps, ctx, menu.map((command) => `/${command.name} — ${command.description}`).join("\n"));
            break;
        }
    }
    return "command";
}
/** Parse `/name[@bot] args`; names outside the command grammar stay text. */
function parseCommand(text) {
    const match = text.match(/^\/([a-z][a-z0-9-]*)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
    if (match === null)
        return undefined;
    return { name: match[1] ?? "", args: match[2]?.trim() ?? "" };
}
/** Only catalog rows carrying an extension slug are chat-invokable. */
async function extensionCommands(host) {
    const reserved = new Set(GATEWAY_COMMANDS.map((command) => command.name));
    return (await host.commands.list()).flatMap((command) => command.extension === undefined || reserved.has(command.name)
        ? []
        : [{ name: command.name, description: command.description, extension: command.extension }]);
}
/** The common bound-conversation write gate (link/pair are exempt). */
async function hasBoundWriteAccess(deps, ctx) {
    if (ctx.user === undefined || ctx.binding === undefined)
        return false;
    const meta = await deps.host.conversations.meta(ctx.binding.conversationId);
    const access = await deps.host.access.accessOf({ user: ctx.user }, { owner: meta.owner, sharing: meta.sharing });
    return access === "write";
}
/** Run one operation that requires an existing bound conversation. */
async function requireBinding(deps, ctx, operation) {
    if (ctx.binding === undefined) {
        await reply(deps, ctx, "This chat is not bound to a conversation.");
        return;
    }
    await operation(ctx.binding.conversationId);
}
/** `/new`: the same creation shape as first admission, then rebind. */
async function newConversation(deps, ctx) {
    const owner = ctx.group?.owner ?? ctx.user;
    if (owner === undefined) {
        await reply(deps, ctx, "run this as a named user");
        return;
    }
    const conversationId = await deps.host.conversations.create({
        owner,
        source: "gateway",
        name: ctx.event.chat.title ?? `${deps.channel.label} DM`,
        ...(ctx.group?.members !== "anyone"
            ? {}
            : {
                agent: {
                    ...(ctx.group.tools === undefined ? {} : { tools: ctx.group.tools }),
                    ...(ctx.group.extensions === undefined ? {} : { extensions: ctx.group.extensions }),
                },
            }),
    });
    await deps.bindings.bind(ctx.bindingKey, conversationId, ctx.event.chat);
    await reply(deps, ctx, `Started conversation ${String(conversationId)}.`);
}
/** `/stop`: Task 5 owns the live abort's exact "Stopped." notice. */
async function stopRun(deps, ctx) {
    await requireBinding(deps, ctx, async (conversationId) => {
        const latest = await latestView(deps.host, conversationId);
        if (latest?.steer.busy !== true) {
            await reply(deps, ctx, "Nothing is running.");
            return;
        }
        await deps.host.conversations.abort(conversationId);
        // An aborted preview never finalizes: release its watch/timers so
        // Task 5's origin notice is the command's only reply.
        deps.streams?.abandon(conversationId);
    });
}
/** `/model`: no args lists the current and served refs; args configure. */
async function configureModel(deps, ctx, args) {
    await requireBinding(deps, ctx, async (conversationId) => {
        if (args !== "") {
            await deps.host.conversations.configure(conversationId, { model: args });
            await reply(deps, ctx, `Model set to ${args}.`);
            return;
        }
        const latest = await latestView(deps.host, conversationId);
        const current = modelRef(latest) ?? "not configured";
        const models = await deps.host.models.list();
        await reply(deps, ctx, [`Current model: ${current}`, ...models.map((model) => model.id)].join("\n"));
    });
}
/** `/thinking`: no args lists levels; an arg configures the next run. */
async function configureThinking(deps, ctx, args) {
    await requireBinding(deps, ctx, async (conversationId) => {
        if (args !== "") {
            if (!THINKING_LEVELS.includes(args)) {
                await reply(deps, ctx, `usage: /thinking [${THINKING_LEVELS.join(" | ")}]`);
                return;
            }
            await deps.host.conversations.configure(conversationId, {
                thinking: args,
            });
            await reply(deps, ctx, `Thinking level set to ${args}.`);
            return;
        }
        const latest = await latestView(deps.host, conversationId);
        const current = thinkingLevel(latest) ?? "not configured";
        await reply(deps, ctx, [`Current thinking level: ${current}`, ...THINKING_LEVELS].join("\n"));
    });
}
/** `/attach`: authorize the target independently, then rebind. */
async function attachConversation(deps, ctx, args) {
    if (!/^[1-9][0-9]*$/.test(args) || ctx.user === undefined) {
        await reply(deps, ctx, "usage: /attach <conversation-id>");
        return;
    }
    const conversationId = Number(args);
    const meta = await deps.host.conversations.meta(conversationId);
    const access = await deps.host.access.accessOf({ user: ctx.user }, { owner: meta.owner, sharing: meta.sharing });
    if (access !== "write") {
        await reply(deps, ctx, "You do not have write access to that conversation.");
        return;
    }
    await deps.bindings.bind(ctx.bindingKey, conversationId, ctx.event.chat);
    await reply(deps, ctx, `Attached to conversation ${args}.`);
}
/** `/status`: name, resolved model, live queue state, and binding id. */
async function showStatus(deps, ctx) {
    await requireBinding(deps, ctx, async (conversationId) => {
        const [meta, latest] = await Promise.all([
            deps.host.conversations.meta(conversationId),
            latestView(deps.host, conversationId),
        ]);
        const state = latest?.steer.busy === true
            ? `busy, ${latest.steer.queued} queued`
            : `idle, ${latest?.steer.queued ?? 0} queued`;
        await reply(deps, ctx, [
            `Conversation: ${meta.name ?? "unnamed"}`,
            `Model: ${modelRef(latest) ?? "not configured"}`,
            `State: ${state}`,
            `Bound conversation: ${String(conversationId)}`,
        ].join("\n"));
    });
}
/** Read the newest frame and release the one-shot watch immediately. */
async function latestView(host, conversationId) {
    let latest;
    const release = await host.conversations.watch(conversationId, (view) => {
        latest = view;
    });
    await release();
    return latest;
}
/** Structural read of the resolved agent document (wire docs are JSON). */
function agentDoc(view) {
    const doc = view?.docs["pi.agent"];
    return isRecord(doc) ? doc : undefined;
}
function modelRef(view) {
    const model = agentDoc(view)?.model;
    if (!isRecord(model))
        return undefined;
    return typeof model.provider === "string" && typeof model.modelId === "string"
        ? `${model.provider}/${model.modelId}`
        : undefined;
}
function thinkingLevel(view) {
    const level = agentDoc(view)?.thinkingLevel;
    return typeof level === "string" ? level : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Command replies are best-effort transport notices, like pipeline notices. */
async function reply(deps, ctx, text) {
    try {
        await deps.channel.send({ chat: ctx.event.chat, text });
    }
    catch (error) {
        deps.log.error("chat command reply send failed", error);
    }
}
