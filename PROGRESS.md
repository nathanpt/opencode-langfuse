# PROGRESS.md — opencode-langfuse

## Current repository state

- Branch `master`. Foundation + research + accepted design committed 2026-11-09 (first commit —
  operator approved per-feature commits, foundation first).
- **Design gate passed 2026-11-09:** operator approved the design package and accepted ADR-0001
  (config storage) and ADR-0002 (usage/cost). Live-verification target: reuse the omp-langfuse
  config keys (same self-hosted Langfuse project).
- Implementation has started, in feature-contract order: feature-001 → feature-010 → 002 → 003 →
  004 → 005.

## Confirmed working surfaces

- `opencode` v2.0.31 installed and on PATH; plugin API verified from docs and runtime probes
  (see docs/references/opencode-plugin-api.md → Runtime-verified).
- OpenCode hot-reloads plugin/config changes under watched config dirs (probe-verified).
- The omp-langfuse config at `~/.omp/agent/omp-langfuse/config.json` (0600) holds reusable
  credentials for the self-hosted Langfuse — the approved verification target.

## Active work

- **feature-001** — plugin loads in OpenCode v2 without errors and announces tracing.
- **feature-010** — credential resolution per ADR-0001 (env → 0600 config file → disabled with
  status). Tooling (package.json, tsconfig, test runner) ships with this slice.

## Blockers and unknowns

- None blocking. Open sub-question from ADR-0002: tier discriminator for context-threshold
  pricing (v0 uses the first tier).
- Probe scratch lives in `/tmp/r1-probe` (ephemeral); findings are distilled into the docs.

## Verification status

- feature-001: not yet implemented.
- feature-010: not yet implemented.
- Features 002–013: blocked behind 001/010 (see docs/feature-list.json).

## Next useful move

- Implement the config module + plugin skeleton, typecheck, unit-test config resolution, then
  verify feature-001 and feature-010 live (scratch project, `opencode plugin list` + startup
  status line with and without credentials).
