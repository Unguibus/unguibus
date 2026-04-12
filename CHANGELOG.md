# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project skeleton: `package.json`, `tsconfig.json` (strict), `biome.json`, `LICENSE` (MIT), CI workflow.
- Config loader for TOML at the platform-default path or `UNGUIBUS_HOME`; duration strings (`ns`–`w`), subscription/connector validation.
- SQLite schema (events, direct subscriptions, tags, session state, connector state) via `bun:sqlite`.
- Service-layer actions: `publish_event`, `query_events`, `subscribe`, `unsubscribe`, `list_subscriptions`, `tag`, `untag`, `list_tags`, `get_pending_events`, `claim_pending_events`. CloudEvents 1.0 envelope with `publishedAt` extension. Idempotency on caller-supplied event `id`.
- REST server on `127.0.0.1:<port>` (loopback only): health check, events, subscriptions, tags endpoints.
- `unguibus` CLI covering publish/query/pending/subscribe/unsubscribe/subscriptions/tag/untag/tags with `--json`.
