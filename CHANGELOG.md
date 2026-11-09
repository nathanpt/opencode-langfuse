# Changelog

All notable changes to this project are documented in this file. Format based on
[Keep a Changelog](https://keepachangelog.com); versioning: SemVer. No release has shipped yet.

## Unreleased

### Added

- Operating foundation: README, AGENTS.md (two-part standard rules v1.2), ARCHITECTURE.md,
  PROGRESS.md, feature contract (`docs/feature-list.json`), decision layer (`docs/decisions/`),
  research references (OpenCode v2 plugin API notes, omp-langfuse reuse inventory), and the active
  research/design exec plan.
- Plugin skeleton (`src/index.ts`, `src/config.ts`): loads as an OpenCode v2 server plugin and
  announces tracing state at startup; credential resolution per ADR-0001 (env vars → 0600 config
  file at `~/.config/opencode-langfuse/config.json` → disabled with a stated reason). Verified
  live against OpenCode v2.0.31 (load, banner, env-over-file precedence).
