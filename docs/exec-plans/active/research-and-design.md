# Exec plan — research & design (pre-implementation)

**Goal:** an approved design for the OpenCode v2 Langfuse plugin — the most elegant port of the
omp-langfuse trace model onto OpenCode's hook surface — before any code exists in this repo.

**Gate:** the operator approves the design. No implementation code before that (AGENTS.md hard
constraint 1). Scratch/probe plugins live outside this repo (e.g. `/tmp`) and never ship.

## R1 — Token-usage capture point (ARCHITECTURE unknown 1) — **done 2026-11-09**

Probe: `/tmp/r1-probe` (scratch plugin, plain-object export; local OpenAI-compatible mock at
`127.0.0.1:8123`; four `opencode run` sessions incl. tool-failure and tool-success paths).
Evidence: `/tmp/r1-probe/out/` + the Runtime-verified section of
docs/references/opencode-plugin-api.md.

**Decision:** tokens come from the event stream — `session.step.ended` (one per model request,
with `assistantMessageID`, `tokens {input, output, reasoning, cache {read, write}}`, host `cost`)
and `session.usage.updated` (cumulative). `http.response` body-teeing verified working but
unnecessary; kept as diagnostic only.

Bonus findings: host `cost` = 0 for unpriced models (advances R2); title traffic lands after
`session.execution.succeeded` and has no step events (advances R5); v2 tool names enumerated;
tool lifecycle events keyed by call `id` with `session.tool.success`/`failed` + `shell.exited`.

- Acceptance: met — decision documented with captured evidence.

## R2 — Model cost semantics + pricing source (unknown 2) — **done 2026-11-09**

Probe: mock model priced `{input: 1.5, output: 9, cache_read: 0.15, cache_write: 1.25}`;
`ctx.model.list()` dumped raw (incl. the 12 built-in `opencode` free models).

Findings: `model.list()` → `{location, data}`; `cost` = tier array `{input, output,
cache {read, write}}`; units USD/Mtok; host cost `0.0001185` = `37×1.5 + 5×9 + 2×9` µ$
(`cache.read` dropped by the host formula); config-defined providers' models absent from
`model.list()`.

**Decision:** layered price resolution (config override → model.list tier → bundled table → omit
+ warn); cost always self-computed including cache terms and reasoning-at-output-rate.
Recorded as **ADR-0002 (proposed)**. The tier-discriminator sub-question was resolved
2026-11-10 (ADR-0002 amendment): context-threshold tiers select by
`input + cacheRead + cacheWrite` against `tier.size` — see ADR-0002 Decision item 2.

- Acceptance: met — decision recorded; ADR-0002 drafted.

## R3 — Subagent / child-session model (unknown 3) — **done 2026-11-09**

Probe: mock requested the `subagent` tool (`agent: "general"`, `prompt` with SUBAGENT-MARKER,
`description`); the child session completed and the parent continued.

Findings: child sessions are first-class — `session.created` carries `parentID`, `agent`,
`title`; the child emits its own `session.step.*` / `usage.updated` / `execution.*` events.

**Design note (trace grouping):** port the sibling's linkage — child trace named
`opencode-subagent:<agent>`, `metadata.parentSessionID` = `parentID`, grouped under the parent
session trace. Feature-013 is viable, no descope.

- Acceptance: met — grouping design recorded with evidence.

## R4 — Config & credential storage (unknown 4) — **done 2026-11-09**

Probe: `ctx.storage.set/get` roundtrip verified; the value persisted into OpenCode's central
sqlite (`~/.local/share/opencode/opencode.db`, 0600, WAL-backed — found in `-wal` before
checkpoint). Plugin-process env check returned no `LANGFUSE*` vars — the service inherits
nothing on this machine.

**Decision (ADR-0001, proposed):** env vars first, dedicated 0600 config file second
(`~/.config/opencode-langfuse/config.json`, sibling-shaped); `ctx.options` rejected (committed
config), `ctx.storage` rejected for credentials (opaque harness db; acceptable for
non-sensitive state later); no interactive first-run prompt in v0 — unconfigured loads disabled
with a clear status line. Service-env caveat documented.

- Acceptance: met — ADR-0001 created.

## R5 — Flush/shutdown timing (unknown 5) — **done 2026-11-09**

Evidence: `setup` ran once and survived seven `opencode run` sessions in one server process;
the cleanup function ran only on config-dir reloads (17:56:08, 18:00:16, 18:01:21, 18:32:26 in
meta.log); title and child-session traffic trails `session.execution.succeeded`.

**Design note:** flush per session on `execution.succeeded` with a bounded grace window
(~1.5 s, the sibling's OTel visibility timeout) for trailing traffic; the cleanup function is
the final timeout-bounded shutdown with the REST fallback. Recorded in ARCHITECTURE.md
(unknowns → resolved).

- Acceptance: met — flush design recorded.

## R6 — Design package for approval — **accepted 2026-11-09**

All five unknowns resolved; ARCHITECTURE.md current. Operator approved on 2026-11-09:

- Design package: **approved as presented**.
- ADR-0001 and ADR-0002: **accepted**.
- Live-verification target: **reuse the omp-langfuse config keys** (same self-hosted Langfuse
  project; traces distinguishable by source metadata).
- Commit policy: **commit after each verified feature**, foundation committed first.

Implementation starts in feature-contract order: feature-001 → feature-010 → 002 → 003 → 004 → 005.

## Awaiting operator input

- Additional example-repo links beyond `omp-langfuse` may arrive; fold them into the reuse
  inventory when they do.
