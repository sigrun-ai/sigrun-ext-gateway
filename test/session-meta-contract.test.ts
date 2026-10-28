/**
 * Compile-time contract for the gateway's job-delivery metadata read.
 *
 * The canonical job fields live on core/shared `SessionMeta`; the
 * settled fan-out must consume that shape, not a hand-copied duplicate.
 * These assignments are checked by `npm run typecheck` (there is no
 * runtime behavior to pin here — the settled tests own serialization).
 */

import type { SessionMeta } from "@sigrun/shared/session-meta";
import { expect, test } from "vitest";
import type { SettledDeps } from "../src/outbound/settled.js";

/** The gateway read shape, taken from the real dependency interface. */
type GatewayJobMeta = NonNullable<
	Awaited<ReturnType<NonNullable<SettledDeps["readMeta"]>>>
>;

/** The canonical fields the gateway's settled delivery consumes. */
type CanonicalJobMeta = Pick<
	SessionMeta,
	"owner" | "name" | "autoName" | "jobId" | "deliver"
>;

/** A fully-populated canonical session-meta record (core/shared shape). */
const canonicalJobMeta: SessionMeta = {
	pinned: false,
	tagged: [],
	archived: false,
	draft: { text: "", attachments: [] },
	source: "job",
	owner: "alice",
	name: "Nightly report",
	autoName: "Nightly report (auto)",
	jobId: "api:nightly",
	deliver: ["loop:100000001"],
};

/** Core/shared job metadata must be assignable to the gateway read. */
const gatewayJobMeta: GatewayJobMeta = canonicalJobMeta;

/** The gateway read must also satisfy the canonical picked shape. */
const canonicalRoundTrip: CanonicalJobMeta = gatewayJobMeta;

/**
 * Field-name pins: removing a field from the gateway's read shape makes
 * its indexed access a compile error. The optional `| undefined` value
 * type is preserved; these fields need not be populated on every meta.
 */
const ownerPin: GatewayJobMeta["owner"] = gatewayJobMeta.owner;
const namePin: GatewayJobMeta["name"] = gatewayJobMeta.name;
const autoNamePin: GatewayJobMeta["autoName"] = gatewayJobMeta.autoName;
const jobIdPin: GatewayJobMeta["jobId"] = gatewayJobMeta.jobId;
const deliverPin: GatewayJobMeta["deliver"] = gatewayJobMeta.deliver;

void [ownerPin, namePin, autoNamePin, jobIdPin, deliverPin];

void canonicalRoundTrip;

test("canonical job metadata is accepted by the gateway read shape", () => {
	// The compile-time assignments above are the contract; this assertion
	// keeps the file a vitest suite and pins the fixture's own values.
	expect(gatewayJobMeta).toEqual(canonicalJobMeta);
});
