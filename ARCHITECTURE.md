# ARCHITECTURE.md — opencode-langfuse

Status: implementation phase. Facts are verified against the OpenCode v2 plugin docs (fetched
2026-11-09, against installed opencode v2.0.31) and a read of the sibling `omp-langfuse` v0.4.0
source. Features 001–010 are implemented and live-verified (see PROGRESS.md);
remaining features and items marked **UNKNOWN** are open work; see docs/feature-list.json.

## What this system is

An OpenCode v2 plugin, loaded in-process into the OpenCode server, that observes agent sessions
and exports one Langfuse trace per session to an external Langfuse instance (cloud or
self-hosted — the host comes from configuration; default `https://cloud.langfuse.com`). There is
no local storage tier; the only buffering is in-memory between an event and the next flush.

## Host boundary (OpenCode, verified)

- Plugin form: server part, `Plugin.define({ id, setup(ctx) })`; hook/transform registrations are
  disposed automatically at unload, and `setup` may return a cleanup function — the flush/shutdown
  hook point.
- Hook surface this design uses:
  - `ctx.session.hook("prompt" | "context" | "compaction" | "generate" | "title" | "model.request"
    | "http.request" | "http.response" | "retry")` — session/model lifecycle; events carry
    `sessionID`, `agent`, `model {providerID, id, variant}`, and `kind`
    (`"primary" | "compaction" | "title" | "generate"`).
  - `ctx.tool.hook("execute.before" | "execute.after")` — `tool`, `input`, and after: `status`
    (`"completed" | "error"`), `result`, `error`.
  - `ctx.event.subscribe({ types?, signal })` — public event stream (e.g. `session.idle`).
- Context reads this design uses: `ctx.session.get/context/list`, `ctx.model.list` (Model.Info
  carries `cost` tiers — USD per 1M tokens, resolved 2026-11-09 (R2); returns `{location, data}`;
  config-defined providers' models are omitted — known gap per ADR-0002), `ctx.vcs` (repo
  info/status), `ctx.location` (directory, project), `ctx.options`, `ctx.storage` (durable
  plugin-scoped JSON).
- Loading/discovery: `.opencode/plugins/` auto-discovery; `plugins` array in `opencode.json(c)`
  (object form passes `ctx.options`); `opencode plugin add/list/remove`; watched config dirs hot-
  reload. Local plugins may be `.ts` directly.

## Component map (planned)

```
setup(ctx)
├── config      credentials + options: env vars → 0600 config file    [ADR-0001, accepted]
├── capture     privacy presets + redaction      port of omp-langfuse capture-policy/redaction
├── observe     hook/event → observation builders: session, generation, tool, compaction
├── pricing     price resolution + cost          implemented (src/pricing.ts); layered
│                                                resolution per ADR-0002, no runtime deps
├── metadata    git/repo source metadata         via ctx.vcs (replaces sibling's manual git)
├── transport   Langfuse REST ingestion client + flush/shutdown (scores land with a later feature)
└── state       per-session state + score aggregation, keyed by sessionID
```

Dependency direction: `observe` and `metadata` feed `transport` through `state`; `capture` and
`pricing` are pure functions over payloads; `config` is read once in `setup` and passed down.
Nothing outside `transport` talks to the network.

## Trace model (target)

Same shape as omp-langfuse, renamed for this harness: one trace per session; root observation
(user prompt → final assistant response); one generation per primary model request; auxiliary
requests (compaction, title, generate) recorded and tagged by `kind` (sibling precedent: advisor
role tagging); tool observations with `level=ERROR` on failure; a span for compaction; trace-level
scores (`tool_call_count`, `turn_count`, `total_tool_errors`, `tool_success_rate`,
`session_had_errors`) attached when the session ends.

Implemented so far: the trace/root with **deterministic identity** derived from the session id
(ADR-0003), one generation per primary request acquired from durable `session.step.*` identity,
tagged auxiliary generations acquired from `http.request`/`http.response` via exact
`Request` identity (demand-driven body observer, full-completion timing), token `usageDetails`
on primary generations from the R1 capture point, and self-computed `costDetails` per ADR-0002
(feature-005: usage × one resolved price from config override → catalog first tier → bundled
table; omitted with a once-per-model warning when unresolvable; host `cost` kept only as
diagnostic `metadata.hostCost`). Root-sibling observations and scores per ADR-0004: tool spans
(006 — operator-selected exit-code classification, exact-identity pairing, one observation per
call), compaction spans (007 — one content-free span per native lifecycle, deterministic
identity from the start sequence), and the five cumulative trace scores (008 — published only
when complete history is provable and every admitted tool has an authoritative terminal;
omitted with a bounded warning after a compacted cold restore). Still to come: child
traces (013), source metadata (011), slash commands (012).

## Design decisions (all five resolved 2026-11-09)

1. **Token-usage capture point** — **resolved 2026-11-09 (R1):** the event stream is the source.
   `session.step.ended` fires once per model request (`assistantMessageID`, `finish`, host `cost`,
   `tokens {input, output, reasoning, cache {read, write}}`); `session.usage.updated` is the
   cumulative per-session total. `http.response` body-teeing works but stays a diagnostic/fallback
   only. Evidence: docs/references/opencode-plugin-api.md → Runtime-verified.
2. **`Model.Info.cost` semantics** — **resolved 2026-11-09 (R2):** `model.list()` returns
   `{location, data}`; `cost` is a tier array of `{input, output, cache {read, write}}` in
   **USD per 1M tokens**. Host `cost` is untrustworthy twice over: 0 for unpriced models and
   missing `cache.read` for priced ones. Cost is always self-computed — decision and precedence in
   ADR-0002 (accepted). Known gap: `model.list()` omits config-defined providers' models.
3. **Subagent/child-session model** — **resolved 2026-11-09 (R3):** subagents are real child
   sessions; `session.created` carries `parentID`, `agent` (subagent name), and `title`, with the
   child's own step/usage events. The sibling's `parent_trace_id` grouping **ports**: child traces
   are named `opencode-subagent:<agent>` and carry `metadata.parentSessionID` = `parentID`.
4. **Config & credential storage** — **resolved 2026-11-09 (R4):** env vars first
   (`LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL|HOST` + capture overrides), then a dedicated 0600
   config file (`~/.config/opencode-langfuse/config.json`, sibling-shaped); `ctx.options`
   rejected (committed config = leak vector); `ctx.storage` rejected for credentials (verified
   working and 0600-sqlite-backed, but opaque to inspect/rotate); no interactive first-run
   prompt in v0 — unconfigured loads disabled with a clear status line. ADR-0001 (accepted).
   Operational caveat (probe-verified): env vars must reach the service process — export, then
   `opencode service restart`, or run `--standalone`.
5. **Flush/shutdown timing** — **resolved 2026-11-09 (R5, design):** the plugin runs in the
   long-lived server process; sessions end without unloading it (one `setup` across seven runs),
   and the cleanup function fires on unload/reload only (four observed). Flush is per session:
   on `session.execution.succeeded` (parent and each child session), hold a bounded grace window
   (~1.5 s) for trailing title/usage/child traffic, then flush that session's batch; the cleanup
   function performs the final timeout-bounded shutdown. The transport is REST-only
   (`POST /api/public/ingestion`, one retry, per-event 207 acceptance replaces the sibling's
   OTel queue + REST fallback). `session.created` can race the event subscription on a cold
   plugin load, so a prompt for an unknown session reconciles via `ctx.session.get` (primaries
   become records; children stay skipped; lookup failure fails open).

## Where to look next

- docs/exec-plans/active/research-and-design.md — current plan, phases R1–R6, acceptance gate.
- docs/references/opencode-plugin-api.md — verified API notes with sources.
- docs/references/omp-langfuse-reuse-inventory.md — what to port vs rewrite.
- docs/decisions/README.md — ADR index and template.

## Verification levels

- **Unit** — pricing resolution, redaction, capture policy, observation builders (pure logic).
- **Integration** — plugin loads in a real OpenCode; hooks fire; built observations are shaped
  correctly. A scratch probe plugin that dumps event payloads is acceptable scaffolding during
  research but must not ship.
- **End-to-end (required for any trace-path change)** — `opencode run` a multi-turn, multi-tool
  session with an intentional tool failure; fetch the newest trace from the Langfuse API; assert
  usage, costDetails, error level on the failing tool, and all five trace scores. Exact command and
  observed result recorded; skipped verification is reported as unverified, never passing.
