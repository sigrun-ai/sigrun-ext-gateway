# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.24] - 2026-11-08

- The @sigrun/shared peer gains the 0.11.2 line (companion to
  sigrun-core 0.11.2); check-manifest's allowed line widens with it. No
  runtime change.

## [0.1.23] - 2026-11-07

- The @sigrun/shared peer gains the 0.11.1 line (companion to sigrun-core
  0.11.1); check-manifest's allowed line widens with it. No runtime change.

## [0.1.22] - 2026-11-07

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0); @sigrun/shared accepts 0.11.0. The pi-durable 1.5.0 line (0.1.21's registry tarball still carries the 1.4-era peers; this release supersedes it for the 0.11.0 family).

## [Unreleased]

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.10.0).

## [0.1.17] - 2026-11-05
### Fixed
- `@earendil-works/pi-ai` is declared as a peer. `dist/tools.js` imports
  `Type` from it at runtime but the manifest listed only chord and
  pi-durable, so a standalone install (outside a sigrun host that links
  the module) could not resolve it. The host link masked this in
  practice; the declaration now matches the import.

## [0.1.18] - 2026-11-05

- Decline button and declined outcomes in chat: a declinable interaction record renders
  a danger-styled Decline button (any plan kind; budgeted against the channel's
  `buttons.max`, falling back to a numbered list with just the Decline row at the
  boundary), `declineFromChat` (write-access re-checked, terminal peek,
  `host.declineInteraction`), declinedVia-aware settlement edits, and the
  `Reply here to decline.` line for no-button channels. Companion to sigrun-core's
  ask-user release line; the `@sigrun/shared` peer gains the 0.9.0 line.

## [0.1.21] - 2026-11-06

- The @sigrun/shared peer gains the 0.10.2 line (companion to sigrun-core
  0.10.2); check-manifest's allowed line widens with it. No runtime change.

## [0.1.20] - 2026-11-06

- The @sigrun/shared peer gains the 0.10.1 line (companion to sigrun-core
  0.10.1); check-manifest's allowed line widens with it. No runtime change.

## [0.1.19] - 2026-11-06

- The @sigrun/shared peer gains the 0.10.0 line (companion to sigrun-core
  0.10.0); check-manifest's allowed line widens with it. No runtime change.

## [Unreleased]

## [0.1.15] - 2026-11-04

- Peer `@sigrun/shared` gains the 0.8.0 line (companion to sigrun 0.8.0's
  core-notices release). 0.1.15 was tagged before the fake host carried
  the `SigrunHost.notices` member core 0.8.0 adds, so its CI typecheck
  failed against core @main; this is the real release.

## [0.1.14] - 2026-11-04

- Peer `@sigrun/shared` gains the 0.7.0 line (companion to sigrun 0.7.0). 0.1.13 was
  tagged on a commit whose own manifest guard rejected the widened peer (the exact
  0.1.11 failure class); this is the real release.


## [0.1.12] - 2026-11-03

- 0.1.11 was tagged on a commit whose own manifest check rejected the widened peer; never published. This is the real release.

## [0.1.11] - 2026-11-03

- Peer `@sigrun/shared` gains the 0.6.1 line (no gateway-source changes).

## [0.1.10] - 2026-11-02
### Changed
- Widened the `@sigrun/shared` peer to `0.3.0 || 0.4.0 || 0.4.1 || 0.4.2 || 0.5.0 || 0.6.0`
  for the sigrun 0.6.0 release. No behaviour change.
- The test fake host carries core 0.6.0's new host members
  (`conversations.entries`/`entry`, `jobs.get`, `notify`) so the
  package typechecks against the 0.6.0 contract.

## [0.1.9] - 2026-11-02
### Fixed
- The test fake-host carries the (inert) `curation` host member the
  contract requires since sigrun 0.5.0 — the v0.1.8 tag's release run
  failed typecheck against core main. No runtime change (the peer line
  from 0.1.8 rides here; 0.1.8 never published).
## [0.1.8] - 2026-11-02
### Changed
- Widened the `@sigrun/shared` peer to `0.3.0 || 0.4.0 || 0.4.1 || 0.4.2 || 0.5.0`
  for the sigrun 0.5.0 curator release. No behaviour change.
## [0.1.7] - 2026-10-31
### Changed
- Widened the `@sigrun/shared` peer to `0.3.0 || 0.4.0 || 0.4.1 || 0.4.2` for
  the sigrun 0.4.2 dist-fix release. No behaviour change.

## [0.1.6] - 2026-10-31
### Changed
- Widened the `@sigrun/shared` peer to `0.3.0 || 0.4.0 || 0.4.1` for the
  sigrun 0.4.1 hotfix release. No behaviour change.

## [0.1.5] - 2026-10-31
### Changed
- Widened the `@sigrun/shared` peer to `0.3.0 || 0.4.0` so the gateway
  co-installs with the sigrun 0.4.0 core family (and keeps co-installing
  with 0.3.0) without `ERESOLVE`. No behaviour change.

## [0.1.4] - 2026-10-30
### Changed
- Widened the `@sigrun/shared` peer to `0.2.1 || 0.3.0` so the gateway
  co-installs with the sigrun 0.3.0 core family without `ERESOLVE`.
  No behaviour change.
- Forward-compatible with pi-durable 1.4.0 (explicit `checkpointWhen`;
  widened peer range). No behaviour change.

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
