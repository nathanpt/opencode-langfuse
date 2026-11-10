# PROGRESS.md — opencode-langfuse

## Current repository state

- Branch `master`. Foundation committed (030160b); features 001, 002, 010 implemented and
  committed after live verification (per-feature commit policy, operator-approved 2026-11-09);
  feature-003 implemented and live-verified 2026-11-09; feature-004 implemented and
  live-verified 2026-11-09; feature-005 implemented and live-verified 2026-11-10; features
  006–009 implemented and live-verified 2026-11-10 (committed as 5c9864b); features 011–013
  implemented and live-verified 2026-11-10 (committed as 8630e18, 726135a, 3938744). The
  feature list (`docs/feature-list.json`) is complete: features 001–013 all `passes: true`.

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
- `npm run typecheck` (clean) and `npm test` (148/148) green; `npm run build` produces
  `dist/index.js` (~1.8 MB, self-contained).
- **feature-006 (passing, live-verified 2026-11-10, harness `/tmp/oc-features006-009`, stage
  `tools`):** one root-parented span per exact tool call, named for the redacted native tool
  name, paired by the full `(sessionID, assistantMessageID, toolCallID)` identity with
  deterministic ids (ADR-0004). Classification follows the operator-selected rule: the
  `execute.after` error status **or** a finite non-zero structured native shell exit
  (`metadata.exit`) means ERROR with `metadata.nativeStatus`/`exitCode` preserved — the
  preflight proved v2.0.31 reports `status:"completed"` + `exit:7` and the span exported
  `nativeStatus:"completed"`, `exitCode:7`, `level:ERROR`. Successful output containing the
  word "error" stays DEFAULT. The unavailable-`bash` native error path exports one ERROR span
  through the durable `session.tool.failed` fallback (`outcomeSource:"session.tool.failed"`)
  even though no after-hook fires for it. Duplicate/reversed/late facts keep one observation
  per identity; held POSTs submit unchanged snapshots then ordered updates; unnameable calls
  are omitted with one bounded diagnostic; capacity refusal (256) warns once per episode and
  resets; interrupted calls are WARNING, never invented errors; shutdown marks running calls
  `plugin.shutdown`. Two primaries + title intact, each primary cost `0.00011925`; stored
  Langfuse state matched submissions (3 stored shell spans, ERROR/DEFAULT levels).
- **feature-007 (passing, live-verified 2026-11-10, same harness, stage `compaction`):** one
  content-free `kind:"compaction"` span per native compaction lifecycle (ADR-0004). Native
  finding: a second immediate `compact` on a freshly-compacted session fails fast with
  `compaction.unavailable` — the plugin exported that lifecycle honestly as ERROR; two
  successful manual compactions (fresh content between them) produced two distinct spans, each
  matched to its own native `started`/`ended` envelope times, DEFAULT/manual, root-parented,
  with exactly two deliberately induced provider exchanges under the first lifecycle (the
  mock's invalid-then-nudged retry) and no span carrying input/output/usage/cost or any summary
  bytes. Invalid-mode compaction exported an ERROR span with fixed status text `compaction
  failed` while its HTTP-200 auxiliary generations kept honest consumer-side classification;
  stored spans matched submissions.
- **feature-008 (passing, live-verified 2026-11-10, same harness, stage `scores`):** the five
  cumulative trace scores publish on native execution terminals only when complete history is
  provable and every admitted tool has an authoritative terminal (ADR-0004). Live values
  matched native facts exactly: 3/2/1/⅔/1 after a three-tool prompt, 6/4/2/⅔/1 after the
  `--session` continuation with the same five stable score body ids, 0/1/0/1/0 for a plain
  prompt, 1/2/1/0/1 for unavailable-`bash`; warm compaction between prompts did not reset
  totals; a compacted cold restore suppressed all five updates with exactly one
  `Scores omitted … complete history unavailable` warning while observations kept flowing; an
  uncompacted restart restored exact counts without double-counting. `dataType` NUMERIC /
  BOOLEAN (`session_had_errors`), trace linkage, and score ids
  `sha256(opencode-langfuse:score:<sessionID>:<name>)[:32]` verified on submissions and stored
  state.
- **feature-009 (passing, live-verified 2026-11-10, same harness, stage `privacy`):** the
  existing preset contract completed over every new capture path. All four presets exercised
  through emitted payloads (canary `sk-ant-feature069-canary` in prompt, assistant text,
  permitted tool text, nested tool input, and an error message): metadata-only absent content
  fields (keys absent, not null/empty), full-debug redacted canaries (`[REDACTED_SECRET]`),
  `metadata-only` + INPUTS=1/OUTPUTS=0/TOOL_IO=1 and `full-debug` + all-off overrides honored,
  file preset overridden by `LANGFUSE_PRIVACY_PRESET`, numeric usage/cost and complete-history
  scores preserved in every preset, authoritative failure classification and named spans intact,
  fixed failure/status texts under content-off presets, and stored state agreeing with
  submissions. Dynamic emitted strings (tool names, model attribution, lookup/transport/event
  errors) pass the redactor; generation status messages use the fixed capture-status
  explanation while `captureOutputs` is off.
- **feature-011 (passing, live-verified 2026-11-10, harness `/tmp/oc-features011-013`, stage
  `source`):** source/git metadata recorded per trace from the session's own location. Real
  repository case (`/mnt/dev/projects/opencode-langfuse`, plugin via global auto-discovery
  under a temporary real-home): stored `source_type:"git-repo"`, `git_branch:"master"`
  matching the independently read native `ctx.vcs.get` current branch, `git_commit` matching
  independent HEAD, `repo_root_name:"opencode-langfuse"` as the no-origin identity,
  `metadata_source:"git-detection"`, root/observation payloads free of source fields, five
  scores and `0.00011925` primaries unchanged. Scratch git case (branch `feature-011-fixture`,
  credential-bearing synthetic origin): sanitized host/path only, `repo_identity:"demo/opencode-source"`,
  credentials/scheme/query/fragment/`.git`/canary absent. Root override file (applied from a
  nested directory on the same server): `repo_identity:"fixture/override"`, owner/name,
  `service_name`, canary-carrying `environment` redacted, rejected keys (`git_commit`,
  `sessionId`, `parent_trace_id`, `token`, `unknown_key`) omitted, real branch/HEAD retained,
  `metadata_source:"repo-file"`, and a later trace upsert (`--session` continuation) keeps the
  overrides. Metadata-only preset: source metadata present, content fields absent, usage
  numeric. Non-git location: `non-git` source with no repository-file leak, ordinary tracing
  unaffected.
- **feature-012 (passing, live-verified 2026-11-10, same harness, stage `commands`):**
  `/langfuse-status` and `/langfuse-test` work exactly as specified. Disabled case: both
  commands accepted via `POST /api/session/<SID>/command` (204), truthful disabled status
  (state/source/`not configured` host+key/effective preset+flags/redacted reason), test refusal
  logged, zero ingestion attempts. Configured cases (full-debug, metadata-only,
  metadata-only+INPUTS=1, env-over-file, reject switch, cleanliness): active `file`/`env`
  source, redacted host, masked key, resolved preset, all five actual flags, `Last runtime
  error: none` initially. Each test invocation submits one standalone `opencode-langfuse-test`
  trace/root — accepted upstream AND stored in real Langfuse with matching ids, no session
  grouping, no scores, policy-dependent input/output (`{command:"/langfuse-test"}`/`"ok"`),
  metadata exactly `{source:"opencode-langfuse", command:"langfuse-test"}`, distinct ids per
  invocation with no collision against session traces. Reject switch: fixed 503 fails the
  command and records `Last runtime error: [langfuse-test]`; restored pass succeeds and the
  earlier error remains. Cleanliness: status/test produce no provider HTTP calls, no
  transcript/session events, and only the test's own ingestion batch; ordinary tracing
  continues afterward. Live finding recorded in the API reference: `GET /api/command` lists
  config-defined commands only — plugin transform commands are invocable but unlisted.
- **feature-013 (passing, live-verified 2026-11-10, same harness, stage `children`):** a
  parent session whose mock offered `subagent` spawned a real child (`shell` exit 7). Fetched
  via the parent's Langfuse session id: parent trace `opencode-agent` (sessionId=parent) and
  child trace `opencode-subagent:general` (sessionId=parent, ids independently derived from
  the natively observed child session id). Child trace metadata carried `role:"subagent"`,
  `parentSessionID`/`parent_trace_id` matching the native parent, and `agent:"general"`;
  parent trace metadata carries source fields, child trace metadata carries the same source
  fields; roots and all observations stayed under their own trace/root ids. Each trace has
  exactly two primaries (usage `{input:37,…}`, cost `0.00011925` each) and exactly one tool
  span: parent `subagent` DEFAULT, child `shell` ERROR with `nativeStatus:"completed"` /
  `exitCode:7`; the parent did not inherit the shell failure. Stored scores: parent
  1/2/0/1/0, child 1/2/1/0/1, ids keyed by each session's own id. Full-debug redacted the
  canary; metadata-only omitted all content keys without losing linkage/usage/cost/scores.
  Cold restart of only the harness server (same HOME/native store) plus
  `run --session <child> --agent general "F1113-CHILD-CONTINUE"`: child trace/root/score ids
  unchanged, original root input preserved, one additional primary (child scores now
  1/3/1/0/1), parent observations/scores unchanged. The cold-restore seed now applies the
  ADR-0004 rule to recovered shell exits (regression test added after the live gate caught a
  completed exit-7 shell seeding as a success).
- Verification harness: `/tmp/oc-features011-013` (`node harness.mjs
  <source|commands|children>`): mock OpenAI-compatible provider + Langfuse forwarding recorder
  (scratch-only reject switch `POST /fixture/ingestion-mode`) on 127.0.0.1:18127, foreground
  `opencode serve` on 127.0.0.1:14107, per-case temporary homes with 0600 plugin configs
  forwarding to the approved real Langfuse, built plugin under `.opencode/plugins/`, scalar
  evidence plugin (birth/parent/agent/directory/VCS/step/tool/execution identity; a cold-load
  race means `session.created` can predate a plugin's subscription, so the evidence VCS read
  keys on the first observed event and reads the directory from `session.get`). The earlier
  harnesses remain: `/tmp/oc-features006-009` (port 18126), `/tmp/oc-feature005` (18125),
  `/tmp/oc-feature003` (18123), `/tmp/oc-verify` (8123), `/tmp/r1-probe`.

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

- None in flight. Features 001–013 are implemented, live-verified, and committed; the feature
  list (`docs/feature-list.json`) is complete. Each commit's tree passes its recorded
  verification level (006–009: 148 tests; +011: 169; +012: 185; +013: 195; typecheck and build
  clean at every step).

## Blockers and unknowns

- None blocking. Open items: tier discriminator for context-threshold pricing (ADR-0002 note —
  v0 quotes tier zero and flags `firstTierApproximation`); distribution channel (npm vs git)
  deferred to first release — `dist/` is gitignored meanwhile. `GET /api/command` not listing
  plugin-registered commands is a v2.0.31 native behavior (recorded in the API reference), not
  a plugin defect.

## Verification status

- feature-001: passing (live evidence, 2026-11-09).
- feature-010: passing (live evidence, 2026-11-09).
- feature-002: passing (live evidence 2026-11-09; identity mechanics superseded by ADR-0003).
- feature-003: passing (live evidence above, 2026-11-09; ADR-0003).
- feature-004: passing (live evidence above, 2026-11-09; capture point per ADR-0002/R1).
- feature-005: passing (live evidence above, 2026-11-10; pricing layers per ADR-0002).
- feature-006: passing (live evidence above, 2026-11-10; classification rule per ADR-0004).
- feature-007: passing (live evidence above, 2026-11-10; lifecycle identity per ADR-0004).
- feature-008: passing (live evidence above, 2026-11-10; complete-history-only scores per ADR-0004).
- feature-009: passing (live evidence above, 2026-11-10; preset contract over all capture paths).
- feature-011: passing (live evidence above, 2026-11-10; ADR-0005).
- feature-012: passing (live evidence above, 2026-11-10; ADR-0005).
- feature-013: passing (live evidence above, 2026-11-10; ADR-0005).
- Deterministic suite: `npm run typecheck` clean, `npm test` 195/195 green, `npm run build`
  produces `dist/index.js` (self-contained esbuild node22 bundle).

## Next useful move

- The feature list is complete and the work is committed. Useful follow-ups outside the
  current contract: the deferred distribution channel decision (npm vs git) and the ADR-0002
  tier-discriminator note.
