# @sigrun/ext-gateway

The gateway engine extension for sigrun (pi-durable): chat-transport
supervision — channel adapters, the inbound pipeline, and durable
delivery, per the gateway design (spec §8 of the sigrun gateway
design doc).

The sigrun extension-package contract: the default export is a factory
DECLARING the host parameter, returning `{ extension, gateway }` — the
pi-durable extension (declared name `gateway`) plus the C2 engine
object.

## What ships (Task 1)

- `src/config.ts` — `parseGatewayConfig` / `readConfig`: the
  `settings/gateway.json` shape (channels with `dm`/`selfLink`/`allow`/
  `groups`/`busy`/`stream`/`allowBots`, `media.maxBytes`, `notify.home`),
  parsed per read (live config). A malformed channel or group block
  parses to its `{failed}` form and never affects its siblings.
- `src/state/json-file.ts` — `JsonFile<T>`: serialized read-modify-write,
  atomic 0600 writes, malformed-file errors naming the path.
- `src/log.ts` — `hashId` + the scoped `createLog` logger with per-key
  `once` dedupe.
- `src/engine.ts` — the engine skeleton: `start` creates
  `<stateDir>/gateway/`, starts every READY adapter, and records the
  channel set; `stopIntake`/`stop`; `health` reads "ok". Supervision,
  inbound, delivery, and the status route land with their tasks.
- `src/index.ts` — the factory.

Later tasks add the supervisor, the status route, bindings/pipeline,
access control, delivery, streaming, chat commands, groups, and chat
interactions.

## Install

Registered as sigrun's FOURTH built-in (`builtinExtensions.gateway`,
default true) — the dev shape links `file:../sigrun-ext-gateway` from
the sigrun repo. As a published package: `"@sigrun/ext-gateway"` in
sigrun's `extensions[]`.

## Development

```sh
npm install
npm test            # vitest + manifest check
npm run typecheck
npm run build       # tsc -> dist/ (COMMIT the result)
```

State files live in `<stateDir>/gateway/`; tests use `test/fake-host.ts`
(the in-memory `SigrunHost`).
