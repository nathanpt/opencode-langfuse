# PROGRESS.md — opencode-langfuse

## Current repository state

- Branch `master`. Foundation committed (030160b); features 001, 002, 010 implemented and
  committed after live verification (per-feature commit policy, operator-approved 2026-11-09);
  feature-003 implemented and live-verified 2026-11-09; feature-004 implemented and
  live-verified 2026-11-09; feature-005 implemented and live-verified 2026-11-10 (this change).

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
  observation per primary session through the REST ingestion transport; input = user prompt,
  output = final assistant response; subagent child sessions produce no trace. Superseded
  internals: random ids and delete-on-flush were replaced by ADR-0003 deterministic identity.
- **feature-003 (passing, live-verified 2026-11-09, trace
  `1170bd80ba011bb254d376c54cd72e13` / session `ses_e3d0c92b6ffekV4mgdCABnLpAF` on
  `ingest.nathanpeet.com`):** one `GENERATION` per primary model request acquired from durable
  `session.step.*` (true model reference, finish reason, `step.streamed` terminal boundary) plus
  separately tagged auxiliary generations (`title`/`compaction`/`generate`) acquired through
  `http.request`/`http.response` paired by exact `Request` identity with a demand-driven
  pass-through body observer (full-completion timing; EOF/read-error/cancel classification;
  consumer-cancel-after-full-read is retained as `cancelled`/WARNING, never a provider error).
  Verified: cold-load tool loop (2 primaries, title overlapping primary work, deterministic ids
  matching the ADR-0003 seeds); post-flush delayed `generate` exporting under the original root
  on its own timer with terminal ≈ body EOF (3008 ms, not header arrival); reverse-order
  concurrent `generate` pairing; two `compaction` exchanges per compact call (no feature-007
  spans); provider HTTP 400 → `ERROR` generation; model switch adds a `mock-2` primary without
  rewriting earlier `mock-1`; server restart reuses the same trace/root and preserves the
  original root input; `metadata-only` exports no content while the client receives the normal
  answer. No `costDetails` in submitted payloads (feature-005).
- **feature-004 (passing, live-verified 2026-11-09, trace
  `c35c02ecde39679ea8ace12eb65b5440` / session `ses_e3cf15027ffehOvfaEDARrfSUP`):** primary
  generations carry `usageDetails {input: 37, output: 5, total: 49, reasoning: 2, cacheRead: 5}`
  (cacheWrite omitted as zero) — exactly OpenCode's normalization of the provider report
  (prompt 42 − cached 5, completion 7 − reasoning 2) from the R1 capture point
  (`session.step.ended`); partial usage from `session.step.failed` included when reported;
  auxiliary generations carry no plugin-supplied usage. `costDetails` still absent
  (feature-005).
- **feature-005 (passing, live-verified 2026-11-10, harness `/tmp/oc-feature005`, e.g. trace
  `064e3d660d9c4ce61d57f5a462fffa8a` / session `ses_e3c74942dffeJBJ7q85as5eVof`):** primaries
  carry `costDetails` computed once from each request's own usage × an independently resolved
  price (ADR-0002 order: exact config override → native catalog first tier → bundled table →
  omitted + once-per-model warning; sources never mixed). Verified against the live Langfuse:
  override `0.00011925` with all four components (host reported the cache-dropping
  `0.0001185`; delta = exactly the cacheRead term); cache-heavy `0.0002685` with
  `cacheRead 0.00015`; bundled glm-5.2 `0.0000839` (no guessed cacheWrite,
  `pricingSource: bundled`); explicit-free true zero (`source: config`, no warning); unpriced
  and missing-cache-rate sessions export NO `costDetails` key (submitted truth; Langfuse's API
  reads back `{}`) with exactly one warning per provider/model across sessions; auxiliaries
  carry no usage/cost/pricingSource; an invalid host cost never rejects valid tokens; computed
  totals are unchanged by the host value. Catalog unavailability is bounded to one 3 s attempt
  per plugin lifetime (cached failure; late settlement inert). Metadata-only restart: fresh
  priced session keeps numeric usage/cost (`0.00011925`, `pricingSource: config`) while trace/
  root/generation content stays absent and the CLI answer is normal.
- `npm run typecheck` (clean) and `npm test` (88/88) green; `npm run build` produces
  `dist/index.js` (~1.8 MB, self-contained).
- Verification harness: scratch project `/tmp/oc-feature005` (mock OpenAI-compatible provider
  on `127.0.0.1:18125` with a Langfuse ingestion forwarding recorder from
  `/tmp/oc-feature005/mock-server.mjs`, built plugin under `.opencode/plugins/`, foreground
  `opencode serve` on `127.0.0.1:14105` + `opencode run --server`, temporary HOME with a 0600
  plugin config; assertions in `assert-live.mjs`/`assert-submitted.mjs`). The earlier
  `/tmp/oc-feature003` harness (port 18123) verified feature-004; `/tmp/oc-verify` (port 8123)
  predates both.

## Operational findings worth remembering

- **Preflight identity proof (feature-003 gate):** cross-hook `Request` identity
  (`http.request` → `http.response`) held for every admitted exchange on 2.0.31, including two
  concurrent same-kind `generate` calls interleaved with compaction — no FIFO/heuristic matching
  is needed. Evidence script: `/tmp/oc-feature003/.opencode/plugins/feature003-probe.ts`
  (removed from runtime config after the gate; kept as scratch).
- **Auxiliary terminal classification:** the native parser often ends successful auxiliary
  consumption by *cancelling* the body after full read (non-stream JSON and text streams), while
  tool-call streams end at EOF. `cancelled` capture status with HTTP 200 is a normal
  consumer-side boundary, not a provider error (WARNING level, fixed status message).
- **Title requests overlap primary work** (fire at prompt admission, before the first primary
  exchange) and produce no step events; generate/compaction exchanges likewise produce no
  `session.step.*` or `session.text.ended`.
- **Cold-load event race (fixed in feature-002, retained):** a plugin's `ctx.event.subscribe()`
  attaches ~60 ms after `setup`; events for unknown sessions reconcile via `ctx.session.get`/
  `ctx.session.context` (children skipped via `parentID`; lookup failure fails open). Per-session
  serialized state chains retain events that arrive while a lookup is pending.
- The ingest host (`ingest.nathanpeet.com`, proxied) rejects the python-urllib user-agent with
  403 while curl/fetch pass — verification scripts must use curl (auth header file, never argv).
- `opencode plugin list` and `GET /api/plugin` are home/global scoped and the config `plugins`
  array with an absolute local directory entry is silently skipped; the reliable dev/verify path
  is a real session in the project with the plugin under `.opencode/plugins/`.
- Plugin `setup` runs on plugin load/reload, not per session; `console.log` goes to the server
  process stdout (visible with a foreground `opencode serve`).

## Active work

- None in flight. feature-005 done; remaining features 006–013 per `docs/feature-list.json`.

## Blockers and unknowns

- None blocking. Open items: tier discriminator for context-threshold pricing (ADR-0002 note —
  v0 quotes tier zero and flags `firstTierApproximation`); distribution channel (npm vs git)
  deferred to first release — `dist/` is gitignored meanwhile.

## Verification status

- feature-001: passing (live evidence, 2026-11-09).
- feature-010: passing (live evidence, 2026-11-09).
- feature-002: passing (live evidence 2026-11-09; identity mechanics superseded by ADR-0003).
- feature-003: passing (live evidence above, 2026-11-09; ADR-0003).
- feature-004: passing (live evidence above, 2026-11-09; capture point per ADR-0002/R1).
- feature-005: passing (live evidence above, 2026-11-10; pricing layers per ADR-0002).
- Features 006–013: failing/unverified (see docs/feature-list.json).

## Next useful move

- Select the next feature from `docs/feature-list.json` (006–013) and implement one bounded
  unit at a time, live-verifying any trace-path change against the real Langfuse.
