# AGENTS.md — sigrun-ext-gateway

Guidance for coding agents working in this repository.

## What this is

the gateway engine: chat-transport supervision for sigrun (channel
adapters, inbound pipeline, durable delivery) — spec §8 of the sigrun
gateway design doc

A [sigrun](https://github.com/sigrun-ai/sigrun) extension (pi-durable
loader contract): a default-export factory DECLARING the host parameter,
consumed by sigrun's extension loader. Small, single-purpose, no
cross-extension coupling. sigrun's fourth BUILT-IN
(`builtinExtensions.gateway`).

## Layout

- `src/index.ts` — the factory (`createGateway(host)` →
  `{ extension, gateway }`) + the public re-exports.
- `src/engine.ts` — the engine (start/stopIntake/stop/health skeleton
  now; supervision/inbound/delivery land per task).
- `src/config.ts` — `parseGatewayConfig`/`readConfig` (live config,
  `{failed}` isolation per channel/group).
- `src/state/` — engine state files (`json-file.ts`: serialized atomic
  0600 JSON).
- `src/log.ts` — `hashId` + the scoped logger.
- `test/fake-host.ts` — the in-memory `SigrunHost` (every member the
  engine uses; `fake.calls`, `fake.setClaimed`, `fake.pushView`).
- `test/` — vitest suites.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # vitest + manifest check
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- **Types-only `@sigrun/sigrun`**: every import from
  `@sigrun/sigrun/extension` is `import type` (the types-in-main-package
  contract — no runtime dependency on the host package).
- Tests own their literals: synthetic senders/users, no real tokens or
  private URLs in fixtures.
