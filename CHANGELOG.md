# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-28

### Fixed
- The interaction notifier and chat answer correlation now inspect
  records through core's non-consuming `peekInteraction` instead of the
  one-shot delivery read. The early-answer race is closed: a secret
  interaction answered in the webui before the notifier's first pass no
  longer loses the owning extension's raw-secret delivery (the gateway
  owns no delivery; regression-tested with a fixture owner).
- Home-DM settled notices report failed/aborted runs truthfully:
  `Reply ready` only for answered runs; unanswered runs read `Run ended
  without a reply` with the settle reason (empty reasons included).
  Recipient, dedup, bound-conversation suppression, and `notify.home`
  gating are unchanged.

## [0.1.1] - 2026-10-27
### Fixed
- First real publish. `0.1.0` was registered with the npm name bootstrap but
  never published: a staged `0.1.0` entry (left by the bootstrap) made the
  registry reject the release with `E409 Cannot publish over previously
  staged version`. Rejecting that entry removed the package name entirely,
  so the name was re-bootstrapped and `0.1.1` published past it. The package
  contents are the 0.1.0 contents plus the `@sigrun/shared` 0.2.0 peer.

### Changed
- `@sigrun/shared` peer follows the family 0.2.0 cut.

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
