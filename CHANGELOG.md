# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project skeleton: `package.json`, `tsconfig.json` (strict), `biome.json`, `LICENSE` (MIT), CI workflow.
- `[server]` Config loader for TOML at the platform-default path or `UNGUIBUS_HOME`; duration strings (`ns`–`w`), subscription/connector validation.
- `[server]` SQLite schema (events, direct subscriptions, tags, session state, connector state) via `bun:sqlite`.
- `[server]` Service-layer actions: `publish_event`, `query_events`, `subscribe`, `unsubscribe`, `list_subscriptions`, `tag`, `untag`, `list_tags`, `get_pending_events`, `claim_pending_events`. CloudEvents 1.0 envelope with `publishedAt` extension. Idempotency on caller-supplied event `id`.
- `[server]` REST server on `127.0.0.1:<port>` (loopback only): health check, events, subscriptions, tags endpoints.
- `[server]` `unguibus` CLI covering publish/query/pending/subscribe/unsubscribe/subscriptions/tag/untag/tags with `--json`.
- `[server]` Connector runner + polling loop: shell-command-driven event sources with SHA-256 output hashing, per-connector interval/timeout, failure-threshold escalation to `service.unguibus.connector-failed.<name>` after 3 consecutive failures. Each run records its `lastExitCode` in `connector_state`.
- `[server]` Combined hook endpoint `POST /hooks/:hookName/:sessionId`: publishes `agent.claude.<kebab>.<sid>` lifecycle events from `urn:unguibus:hook:<sid>`, updates `lastHookTime`, handles `SessionStart`/`SessionEnd` pid tracking and `Stop` watermark promotion. Delivery hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`) claim pending events and return them as YAML-formatted `additionalContext`.
- `[server]` Hook dispatcher (`unguibus hook <HookName>`) and `install` / `uninstall` commands that merge entries into `~/.claude/settings.json` idempotently.
- `[server]` `unguibus serve` subcommand starts the server with graceful shutdown on SIGINT/SIGTERM.
- Monorepo promotion: `packages/server/` (`@unguibus/server`) holds all existing code; `packages/console/` (`@unguibus/console`) is a stub for the forthcoming read-only Electron observer. Root workspace `package.json` carries the authoritative version; shared tooling (biome, `tsconfig.json`, lockfile, CI) stays at the repo root — `packages/server/tsconfig.json` extends the root. `@unguibus/console` declares its intended `unguibus-console` bin per R6 #35. Implements R6 #34–#37.
- `[server]` Read-only introspection endpoints consumed by `@unguibus/console`: `GET /queues` (per (session, pattern) pending counts + oldest-pending timestamps), `GET /connectors` (configured connectors joined with `lastRunTime`, `lastExitCode`, `consecutiveFailures`, `backoffUntil`), `GET /subscriptions` (all subscriptions across sessions, with origin `direct` or `config` and the tag that routes them), `GET /agent-status` (agent loop state: `state`, `currentSessionId`, `dirty`, `lastLoopTime`, `recentCadenceMs`).
- `[server]` Agent loop: adaptive-pacing event dispatcher that spawns `claude --resume <sessionId> -p "<events>"` for sessions with pending events matching their subscriptions. Mutations set a `dirty` flag to wake the loop; backoff self-regulates as `(elapsed × candidateSetSize × backoffFactor)`. Integrated watchdog marks `pendingWarning` after `warnAfter` idle and kills+cleans up after `killAfter`. Spawn failures record exponential backoff and emit `service.unguibus.spawn-failed.<sessionId>` after the threshold (default 3). Startup pid reconciliation verifies each session's recorded pid via liveness + `claude`/`node`/`bun` comm check and clears stale entries.
