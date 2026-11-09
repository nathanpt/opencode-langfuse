# omp-langfuse → opencode-langfuse reuse inventory

Source: read of `~/dev/projects/omp-langfuse` at v0.4.0 (2026-11-09). Dispositions: **port**
(copy with light edits), **adapt** (keep logic, rewire interface), **rewrite** (concept carries,
implementation is harness-specific), **skip** (OMP-specific, no analogue needed).

Verified constraint from the sibling worth keeping in mind: its trace path (lifecycle
subscriptions + `src/handlers/*` observation builders) is the proven design; we port the *design*
and rewrite the *event acquisition* for OpenCode v2 hooks.

| Sibling component | What it does | Disposition | Notes for this repo |
| --- | --- | --- | --- |
| `src/langfuse.ts` (565 ln) | OTel runtime init (`@langfuse/tracing`/`@langfuse/otel` ^5.3), REST fallback ingestion, score sending, flush/shutdown with timeouts, last-error tracking | **port** | Almost harness-agnostic (depends on `state` shape). Keep the REST fallback: self-hosted Langfuse sometimes does not materialize OTel-only traces. |
| `src/handlers/agent.ts`, `turn.ts` | root agent + turn span builders | **adapt** | Builder logic carries; lifecycle signals change from OMP events to `ctx.event.subscribe` + session hooks. |
| `src/handlers/generation.ts` | generation per provider request, usage metadata, TTFT, fallback generation from turn | **adapt** | Usage source is unknown until R1; the builder stays, the feeding event changes. Tag auxiliary requests by `kind` (compaction/title/generate) where the sibling tagged the advisor role. |
| `src/handlers/tool.ts` | tool observation per call, dangling-observation cleanup, error level | **adapt** | `ctx.tool.hook("execute.before"/"execute.after")` maps cleanly; `status: "error"` + `error` gives the level. |
| `src/handlers/advisor.ts` | advisor usage reconciliation | **skip** (adapt concept) | OMP-specific role; OpenCode's analog is request `kind` tagging, folded into generation handling. |
| `src/pricing.ts` | price resolution: config override → bundled exact → bundled family prefix → catalog rate; self-computed cost | **adapt** | Layers 1–3 port as-is. Catalog layer is OMP-specific; OpenCode's `Model.Info.cost` tiers are the candidate replacement — units unverified (R2 decides). |
| `src/capture-policy.ts` | privacy presets (metadata-only / prompts-only / conversations / full-debug) + per-field env overrides | **port** | Harness-agnostic. Same preset names keep operator muscle memory. |
| `src/redaction.ts` | secret/key/path redactor with size limits | **port** | Harness-agnostic. Apply to every payload regardless of preset. |
| `src/state.ts` | per-session AsyncLocalStorage state + score aggregation | **adapt** | OpenCode hooks carry `sessionID` explicitly, so ALS may be unnecessary — prefer a plain `Map<sessionID, state>` unless a probe shows hook callbacks lose context. |
| `src/source-metadata.ts` | git/repo metadata via shell git + `.omp-langfuse.metadata.json` overrides | **adapt** | Use `ctx.vcs` instead of shelling out. Keep the metadata-override file concept (renamed, e.g. `.opencode-langfuse.metadata.json`). |
| `src/config.ts` | credential loading/saving (0600 file), env fallback, first-run UI prompt | **rewrite** | Path and storage decision is ADR-0001 (env vs config file vs `ctx.storage`). OpenCode has no extension UI prompt API — first-run prompting may be impossible; likely env-first. |
| `src/commands.ts` | `/langfuse-status`, `/langfuse-test`, `/langfuse-privacy` handlers | **adapt** | Re-register via `ctx.command.transform`; handlers themselves carry. |
| `src/subagent.ts`, `src/parent-trace.ts` | subagent trace naming, grouping, `parent_trace_id` linkage | **hold** | Revisit after R3 establishes OpenCode's child-session model. |
| `src/role.ts`, `src/utils.ts`, `src/types.ts`, `src/constants.ts` | helpers, types, limits | **adapt** | Port what survives the interface changes; strip OMP types. |
| `index.ts` | OMP lifecycle subscriptions + command registration | **rewrite** | Replaced by `Plugin.define` `setup(ctx)`; this is the only truly new acquisition layer. |
| Distribution: committed `dist/index.js`, git-only install | OMP install surface | **skip** | OpenCode loads local `.ts` directly and supports npm packages; distribution is a later decision (npm publish is possible here, unlike OMP). |
| Test layout (`test/*.test.ts`, `tsx --test`) + CI shape (typecheck/test/build, tag releases) | quality gates | **adopt** | Reuse the pattern when the first implementation slice sets up tooling. |

Reusable hard-won defaults to keep: never trust host cost without proof; redact everything once;
size-limit payloads; flush with timeouts; one-time warnings per missing price; trace-level scores
computed from observed tool outcomes.
