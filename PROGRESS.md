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
- **feature-002 (passing, live-verified 2026-11-09):** one Langfuse trace + one root agent
  observation per primary session through the REST ingestion transport. Cold-boot first session
  (the regression case) traces correctly; input = user prompt, output = final assistant response;
  subagent child sessions produce no trace (parent only). Evidence: traces
  `ses_e3d8e4334ffeEbP8eCFrsPAMpo` / `ses_e3d8e34c8ffeML1NGqG8vUvTIF` on
  `https://ingest.nathanpeet.com`, root SPAN IO matches trace IO, bounded start/end times.
- `npm run typecheck` (clean) and `npm test` (34/34) green; `npm run build` produces
  `dist/index.js` (~1.7 MB, self-contained).
- Verification harness: scratch project `/tmp/oc-verify` (mock OpenAI-compatible provider on
  `127.0.0.1:8123` from `/tmp/r1-probe/mock-server.mjs`, plugin under `.opencode/plugins/`,
  `opencode run` against a foreground `opencode serve`). Server stdout (banner) is visible via
  the service job streams or `--print-logs`.

## Operational findings worth remembering

- **Cold-load event race (fixed in feature-002):** a plugin's `ctx.event.subscribe()` attaches
  ~60 ms after `setup`, so `session.created` of the first session races it and can be missed.
  The tracker reconciles unknown-session prompts via `ctx.session.get` (`parentID` check;
  children skipped; lookup failure fails open). Reload-created plugin instances attach to the
  live bus instantly — but production loads at service boot, so the reconciliation path is the
  load-bearing one.
- **`session.created` for children** carries `parentID`; `ctx.session.get({sessionID})` returns
  `Session.Info` (also carries it) — the lookup fallback distinguishes children from primaries
  when the created event is missed.
- The ingest host (`ingest.nathanpeet.com`, proxied) rejects the python-urllib user-agent with
  403 while curl/fetch pass — verification scripts must use curl, and any future HTTP client
  change should re-check this.
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

- **feature-003** — one generation observation per primary model request with token counts and
  self-computed cost (ADR-0002), auxiliary requests (title/compaction/generate) tagged.

## Blockers and unknowns

- None blocking. Open items: tier discriminator for context-threshold pricing (ADR-0002 note);
  distribution channel (npm vs git) deferred to first release — `dist/` is gitignored meanwhile.

## Verification status

- feature-001: passing (live evidence, 2026-11-09).
- feature-010: passing (live evidence, 2026-11-09).
- feature-002: passing (live evidence above, 2026-11-09).
- Features 003–013: failing/unverified (see docs/feature-list.json).

## Next useful move

- Implement feature-003: per-generation observations from `session.step.started/ended`
  (tokens per request), price resolution layers per ADR-0002, auxiliary-request tagging via
  `http.*` hook `kind`; verify a two-request tool-loop session produces two generations with
  correct token/cost fields.
