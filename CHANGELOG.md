# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-23
### Added
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
