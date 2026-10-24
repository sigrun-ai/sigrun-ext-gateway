# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-23
### Added
- Channel supervision with retry/backoff, adapter status and pairing
  health surfaces, and bounded ordered shutdown.
- The live inbound pipeline: dedupe, allowlist/pairing/self-link access,
  DM and group routing, albums, media uploads, and chat commands.
- Durable final delivery with access re-checks, retry classification,
  crash recovery, home notifications, and one-shot job targets.
- Live response previews through adapter editing, typing fallback,
  authoritative final hand-off, and preview cleanup at shutdown.
- `send_message` and `list_chats` agent tools and the bound-chat prompt
  section.
- User-deletion cleanup for gateway identity links and home chats.
- Operator guide covering configuration, pairing, groups, jobs, and
  disabling the engine or one channel.
- Repository scaffold from the sigrun-ext-codemode shape (host modules as
  `peerDependencies` mirrored in `devDependencies`; `@sigrun/sigrun` and
  `@sigrun/shared` as `file:` devDependencies; manifest hygiene check
  wired into `npm test`; dist committed).
- The loader-contract factory: `createGateway(host)` →
  `{ extension, gateway }` with the pi-durable extension (declared name
  `gateway`) and the engine skeleton — `start` creates
  `<stateDir>/gateway/`, starts every READY channel adapter, and records
  the channel set; `stopIntake`/`stop` resolve; `health` reads `"ok"`.
- `parseGatewayConfig`/`readConfig` (live per-read parsing of
  `settings/gateway.json`; malformed channel/group blocks parse to
  `{failed}` forms without affecting siblings).
- `JsonFile<T>` state primitive (serialized updates, atomic 0600 writes,
  malformed-file errors naming the path).
- `hashId` + the scoped `createLog` logger with per-key `once` dedupe.
- `test/fake-host.ts`: the in-memory `SigrunHost` (conversations, users,
  access, identity, models, commands, interactions, stores; `fake.calls`
  ordered log, `fake.setClaimed`, `fake.pushView`).
