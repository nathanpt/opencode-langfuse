# 0001. Config and credential storage

- Status: accepted (2026-11-09, operator approval)
- Date: 2026-11-09
- Evidence: `/tmp/r1-probe/out/meta.log` (storage roundtrip, env visibility), docs/references/opencode-plugin-api.md → R4/R5

## Context

The plugin needs Langfuse credentials (public/secret key, host) plus privacy-preset and pricing
overrides. Hard constraints: credentials never enter the repo or traces; the machine runs
OpenCode as a **background service**, and the plugin executes inside that service's process.
OpenCode offers four candidate homes: environment variables, `ctx.options` (from
`opencode.json(c)`), `ctx.storage` (plugin-scoped durable JSON), and a plugin-owned file.

Probe evidence:

- **Env visibility:** the plugin sees only the service-inherited environment — with no
  `LANGFUSE*` vars in the service env, `process.env` showed none (`envVisible={}`). Env-based
  config requires the vars to reach the service (export + `opencode service restart`) or a
  `--standalone`/`--server` run.
- **`ctx.storage` works and is durable**: set/get roundtrip verified; the value landed in
  OpenCode's central sqlite (`~/.local/share/opencode/opencode.db`, 0600, WAL-backed).
- `ctx.options` values live in `opencode.json(c)` — a file that is typically committed to repos.
- OpenCode has no extension UI-prompt API; TUI/GUI parts are for UI surfaces, not secret entry.

## Decision drivers

- Credentials never in the repo or traces (hard constraint 4).
- Headless operation must work (background service, CI-style runs).
- Operator already has sibling muscle memory (omp-langfuse env vars + 0600 config file).
- Inspectability and rotation: credentials must be easy to find, check, and rotate.

## Considered options

1. **Env vars only** — headless-friendly; but invisible to an already-running service unless it
   inherits them; awkward for multi-value config (pricing overrides).
2. **Plugin-owned 0600 config file** — transparent, rotatable, survives service restarts; needs
   one-time manual creation.
3. **`ctx.storage`** — verified working, 0600 sqlite; but opaque (buried in the harness WAL db),
   awkward to inspect/rotate, couples credential lifecycle to harness storage.
4. **`ctx.options` in `opencode.json(c)`** — rejected outright: committed config is a credential
   leak vector.

## Decision

Layered resolution, evaluated once in `setup`:

1. **Environment variables**: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
   `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`), plus the per-field capture overrides
   (`LANGFUSE_PRIVACY_PRESET`, `LANGFUSE_CAPTURE_*`) — sibling parity.
2. **Config file** `~/.config/opencode-langfuse/config.json` (dir 0700, file 0600), sibling
   shape: `publicKey`, `secretKey`, `host`, `privacyPreset`, `pricing` overrides. Created by hand
   or a documented copy-paste snippet; **no interactive first-run prompt in v0** (no UI API).
3. **Unconfigured**: the plugin loads, stays disabled, logs one clear reason at startup, and
   reports state via the `/langfuse-status` command — no crash, no trace attempts.

`ctx.options` carries only non-secret toggles if ever needed; `ctx.storage` is acceptable later
for **non-sensitive** plugin state, never credentials.

Operational note (documented in README at implementation): env vars must reach the **service
process** — export them, then `opencode service restart`, or run `opencode --standalone`.

## Consequences

- One-time manual setup per machine; transparent inspection (`cat` the file / `env | grep LANGFUSE`).
- Same resolution story as omp-langfuse, so reuse of `src/config.ts` logic is direct.
- The missing-file + missing-env case is a first-class, tested state (feature-010), not an error path.

## Confirmation

Feature-010's checks: disabled-but-clean startup with no credentials; activation via env and via
file; grep of trace payloads and logs asserting no credential material ever appears.
