/**
 * Deterministic chat presentation for a generic interaction record.
 * The planner admits only answers chat can represent faithfully; every
 * other root form stays in the webui (notably secrets and open choices).
 */
import { toText } from "@sigrun/shared/blocks";
import { renderChunks } from "../outbound/render.js";
/** Plan the one answer mechanism the record's root form supports in chat. */
export function planInteraction(record, caps) {
    const root = record.body?.root;
    if (root?.type !== "form")
        return { kind: "webui" };
    const fields = root.children.filter((child) => child.type !== "section");
    // A section can carry arbitrary presentation/field nesting. Planning
    // only the flat root form avoids claiming a subset of a richer form.
    if (fields.length !== root.children.length)
        return { kind: "webui" };
    const choices = fields.filter((field) => field.type === "choice");
    if (choices.length === 1 &&
        fields.every((field) => field.type === "choice" ||
            ((field.type === "text" || field.type === "longtext") && field.required !== true))) {
        const choice = choices[0];
        if (choice.multi !== true &&
            choice.allowOther === undefined &&
            Array.isArray(choice.options)) {
            return {
                kind: "choice",
                field: choice.name,
                options: choice.options,
                buttons: choice.options.length <= (caps.buttons?.max ?? 0),
            };
        }
    }
    if (fields.length === 1 && (fields[0].type === "text" || fields[0].type === "longtext")) {
        return { kind: "text", field: fields[0].name };
    }
    return { kind: "webui" };
}
/** Render the generic record and its chat-specific answer affordance. */
export function renderInteraction(record, caps, opts) {
    const plan = planInteraction(record, caps);
    const lines = [];
    if (record.body !== undefined) {
        const projected = plan.kind === "choice" ? withoutFormFields(record.body) : record.body;
        const text = toText(projected, {}, { width: 60, locale: "en" });
        if (text !== "")
            lines.push(text);
    }
    if (opts.conversationName !== "")
        lines.push(`Conversation: ${opts.conversationName}`);
    let buttons;
    if (plan.kind === "choice") {
        const options = [...plan.options].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true));
        const label = choiceLabel(record.body, plan.field);
        if (label !== "")
            lines.push(label);
        if (plan.buttons) {
            const row = options.map((option) => ({
                label: truncateLabel(option.label, caps.buttons?.labelMax),
                data: opts.issue({
                    kind: "interaction",
                    field: plan.field,
                    conversationId: opts.conversationId ?? 0,
                    callId: record.callId,
                    optionId: option.id,
                }),
                ...(option.tone === "bad" ? { style: "danger" } : {}),
            }));
            const perRow = Math.max(1, caps.buttons?.perRow ?? row.length);
            const rows = [];
            for (let index = 0; index < row.length; index += perRow)
                rows.push(row.slice(index, index + perRow));
            buttons = rows;
        }
        else {
            options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`));
            lines.push("Reply with a number.");
        }
    }
    else if (plan.kind === "text") {
        lines.push("Reply to this message to answer.");
    }
    else {
        lines.push("Answer this in the webui");
        if (opts.link !== undefined)
            lines.push(opts.link);
    }
    // The body projection is plain text; the capability formatter still
    // runs so native/plain channels get the same §8.6 treatment as finals.
    const formatted = renderChunks(lines.join("\n"), caps).join("\n");
    return {
        text: truncateWithNote(formatted, caps.maxMessageLength),
        ...(buttons === undefined ? {} : { buttons }),
    };
}
/** Omit form fields when buttons/the numbered list replace their rendering. */
function withoutFormFields(tree) {
    if (tree.root.type !== "form")
        return tree;
    const root = { ...tree.root, children: tree.root.children.filter((child) => child.type === "section") };
    return { ...tree, root };
}
function choiceLabel(body, name) {
    if (body?.root.type !== "form")
        return "";
    const field = body.root.children.find((child) => child.type === "choice" && child.name === name);
    return field?.type === "choice" && typeof field.label === "string" ? field.label : "";
}
function truncateLabel(label, max) {
    // Literal options are a planner requirement, so their labels are text.
    const text = typeof label === "string" ? label : "";
    return max === undefined ? text : text.slice(0, Math.max(0, max));
}
function truncateWithNote(text, max) {
    const limit = Math.max(1, max);
    if (text.length <= limit)
        return text;
    const note = "\n… full details in the webui";
    if (limit <= note.length)
        return text.slice(0, limit);
    return `${text.slice(0, limit - note.length).trimEnd()}${note}`;
}
