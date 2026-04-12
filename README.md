# unguibus

Localhost Bun server acting as an event log for event-driven Claude Code integrations. Events flow in from external sources (connectors, webhooks, hooks), trigger Claude Code `--resume` spawns for sessions with matching subscriptions, and Claude can emit events back — enabling looping, chained automation pipelines.

**Scope:** event-driven execution. Session management is out of scope.

**Platform support (Phase 1):** Linux + macOS. Windows is deferred.

## Design

The authoritative spec lives in the sibling [`designs`](https://github.com/Unguibus/designs) repo at [`designs/unguibus/DESIGN.md`](https://github.com/Unguibus/designs/blob/main/unguibus/DESIGN.md). Design decisions are logged in [`designs/unguibus/DECISIONS.md`](https://github.com/Unguibus/designs/blob/main/unguibus/DECISIONS.md).

## Org conventions

Tooling, commit style, versioning, and collaboration norms are defined in the org-level [`processes`](https://github.com/Unguibus/processes) repo.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.1.39.

```sh
bun install

# Sandbox dev/test: point config, DB, and hooks at a local directory.
export UNGUIBUS_HOME="$PWD/.unguibus-home"
mkdir -p "$UNGUIBUS_HOME"

# Run the server.
bun run server

# In another shell, poke it with the CLI.
bun run cli -- publish "urn:test:hello" "local.test.hello-world" --data '{"msg":"hi"}'
bun run cli -- query --limit 5
bun run cli -- subscribe sess-1 "local.test.*"
bun run cli -- pending sess-1
```

See `bun run cli -- --help` for the full CLI surface.

## Development

```sh
bun install
bun test                 # run tests
bunx biome check .       # lint + format check
bunx biome check --write # apply fixes
```

CI runs both `biome check` and `bun test` on every PR and push to `main`.

## Versioning + commits

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) — update `[Unreleased]` on every user-visible change.

See `processes/source-control.md` for the full policy.

## Maintainer

John Winstead ([@brooswit](https://github.com/brooswit))

## License

[MIT](./LICENSE) © 2026 John Winstead
