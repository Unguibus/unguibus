@../processes/ALL.md
@../designs/unguibus/DESIGN.md
@../designs/unguibus/DECISIONS.md

# unguibus — agent notes

Project-local notes only. Authoritative content comes from the imports above:

- `../processes/ALL.md` — org-wide tooling, source-control, collaboration, repos, CLAUDE.md conventions.
- `../designs/unguibus/DESIGN.md` — full spec.
- `../designs/unguibus/DECISIONS.md` — DACI log.

Add `@../specs/unguibus/<file>.md` lines here as specs land under `../specs/unguibus/` (directory does not yet exist).

## Phase map

- **Phase 0 (current)** — bootstrap conversation; iterating on this file.
- **Phase 1** — build unguibus to DESIGN.md. Bootstrap PR lands the skeleton (README, LICENSE, CHANGELOG `[Unreleased]` only, `package.json` at `0.0.0`, `biome.json`, `tsconfig.json` strict, `.github/workflows/ci.yml` green, this CLAUDE.md). **Merging the bootstrap PR = Phase 1 begins.** Enable branch protection on `main` at (or immediately after) that merge: required status checks (biome + test), 1 required approval (self-approval counts solo), no direct/force pushes. Slice-PRs per meaningful layer after that; self-approve. Cut `v0.1.0` at the first usable end-to-end milestone (candidate: REST up, `publish_event` + `query_events` working against SQLite).
- **Phase 2** — dogfood via a GitHub-designs connector (final name proposed in the Phase 2 PR; placeholder is `gh-designs-commits`); event type `service.github.repo-updated.unguibus.designs`; subscribe the current working session. Secrets plan: rely on host `gh` CLI auth; flag for a process update if a token-based approach is needed.

## Project-local conventions

- **Repo layout:** monorepo with Bun workspaces. `packages/server/` (`@unguibus/server`) holds the service, REST, CLI, hooks, connectors. `packages/console/` (`@unguibus/console`) is the read-only Electron observer — package stubbed, implementation pending. Shared tooling (`biome.json`, `bun.lock`, `.github/`) stays at repo root. Per R6 #34 in the upstream DECISIONS log.
- **Bun floor:** ≥ v1.1.39 (`process.ppid` on Windows). Pin via `package.json` `engines`. Even though Phase 1 ships Linux/macOS only, Bun's own cross-platform contract stays the floor so code doesn't regress when Windows parity is picked up later.
- **Platform coverage (Phase 1):** Linux + macOS (POSIX). Don't pre-branch on `process.platform` for Windows paths that may never materialize — YAGNI. README states "Linux/macOS only."
- **Package names:** `@unguibus/server` (binary: `unguibus`) and `@unguibus/console` (binary: `unguibus-console`). Root workspace `package.json` holds the authoritative SemVer version; per-package `package.json` files mirror it on release. See R6 #35 and R6 #37.
- **Maintainer / copyright holder:** `John Winstead`. Use this literal string in `LICENSE` (`Copyright (c) 2026 John Winstead`), `README.md` maintainer line, and `CODEOWNERS`.
- **Test layout:** co-located `*.test.ts` next to sources.
- **`DECISIONS.md`** (in this repo) springs into being with the first non-trivial *implementation* decision — refinements that don't change the design. Decisions that reveal the design is wrong pause work and land in `../designs/unguibus/DECISIONS.md` instead. Copy the DACI format from there. Don't commit an empty file.
- **Changelog granularity:** one `[Unreleased]` bullet per user-visible change (not per PR). A later PR MAY edit an earlier `[Unreleased]` bullet to absorb its change — the sole exception to "no retroactive edits," valid only while still unreleased.
- **Design fidelity drift:** prose-level mismatches (e.g. `Bun.SQLite` in DESIGN.md vs the actual `bun:sqlite` import) are gap-fill: proceed, note in the PR, no pause. The pause bar is "would the design doc need to change?" — not "does the prose need polishing?"

## On entry, verify

Per `processes/claude-md.md`: compare `../processes/ALL.md`'s import list against the actual `*.md` files in `../processes/`. Flag any drift.
