# PROGRESS.md — opencode-langfuse

## Current repository state

- Branch `master`. Foundation committed (030160b); feature-001 + feature-010 implemented and
  committed after live verification (per-feature commit policy, operator-approved 2026-11-09).

## Confirmed working surfaces

- `opencode` v2.0.31; plugin API verified from docs and runtime probes
  (docs/references/opencode-plugin-api.md → Runtime-verified).
- **feature-001 (passing, live-verified):** the built bundle placed under
  `.opencode/plugins/opencode-langfuse.js` in a scratch project loads in a real session —
  server log shows `loading plugin … opencode-langfuse.js` and the startup banner
  `📊 Langfuse: Tracing enabled → <host> (key <masked>, source <env|file>)`. No load errors.
- **feature-010 (passing, live-verified):** all three ADR-0001 states exercised —
  unconfigured → `Disabled — no LANGFUSE_* env vars; ~/.config/opencode-langfuse/config.json:
  config file not found`; config file (0600, provisioned from the approved omp-langfuse keys,
  host `https://ingest.nathanpeet.com`) → `Tracing enabled … source file`; env vars present in
  the server process → `Tracing enabled → https://cloud.langfuse.com … source env`
  (env-over-file precedence proven with the file present).
- `npm run typecheck` (clean) and `npm test` (11/11) green; `npm run build` produces
  `dist/index.js` (~1.7 MB, self-contained).
- Verification harness: scratch project `/tmp/oc-verify` (mock OpenAI-compatible provider on
  `127.0.0.1:8123` from `/tmp/r1-probe/mock-server.mjs`, plugin under `.opencode/plugins/`,
  `opencode run` against a foreground `opencode serve`). Server stdout (banner) is visible via
  the service job streams or `--print-logs`.

## Operational findings worth remembering

- `opencode plugin list` and `GET /api/plugin` are **home/global-location scoped** — they do not
  list project-scoped plugins, and (on 2.0.31) the config `plugins` array with an absolute local
  directory entry (object or string form) is silently skipped; the reliable dev/verify path is a
  real session in the project with the plugin under `.opencode/plugins/`.
- The plugin's `console.log` goes to the server process stdout — visible when the server runs in
  the foreground (`opencode serve`, our harness) or via `--print-logs`; the daemonized background
  service's stdout is not captured in `opencode.log`.
- Plugin `setup` runs on plugin load/reload, not per session — credential-file changes need a
  plugin reload (touch the plugin file) to be picked up.

## Active work

- **feature-002** — one Langfuse trace per session with a root observation (first live trace
  through the transport port of sibling `langfuse.ts`), verified against the self-hosted
  Langfuse (`https://ingest.nathanpeet.com`, keys in `~/.config/opencode-langfuse/config.json`).

## Blockers and unknowns

- None blocking. Open items: tier discriminator for context-threshold pricing (ADR-0002 note);
  distribution channel (npm vs git) deferred to first release — `dist/` is gitignored meanwhile.

## Verification status

- feature-001: passing (live evidence above, 2026-11-09).
- feature-010: passing (live evidence above, 2026-11-09).
- Features 002–013: failing/unverified (see docs/feature-list.json).

## Next useful move

- Implement feature-002: port the transport (`src/langfuse.ts` equivalent) with per-session
  flush, wire `session.execution.succeeded` + grace window, run a real session, and fetch the
  newest trace from the Langfuse API to assert the trace + root observation.
