# 0002. Usage capture and cost computation

- Status: accepted (2026-11-09, operator approval)
- Date: 2026-11-09
- Evidence: `/tmp/r1-probe/out/` (runs 1–7), `docs/references/opencode-plugin-api.md` → Runtime-verified

## Context

The plugin records one Langfuse generation per OpenCode model request and must attach token usage
and a **trustworthy cost** to each. OpenCode's event stream already surfaces normalized usage
(`session.step.ended`: `tokens {input, output, reasoning, cache {read, write}}` per request). The
open question was where cost comes from and what units OpenCode's cost model uses.

Probe findings that force this decision:

- Host `cost` is **0 for unpriced models** (R1) — same failure mode as OMP (omp-langfuse lesson).
- Host `cost` is **incomplete for priced models too**: with model cost configured
  (`input 1.5, output 9, cache_read 0.15, cache_write 1.25` USD/Mtok) and tokens
  `input 37, output 5, reasoning 2, cache.read 5`, the host emitted `cost = 0.0001185` =
  `37×1.5 + 5×9 + 2×9` µ$ — **`cache.read` is dropped** from the host formula.
- `ctx.model.list()` returns `{location, data: Model.Info[]}` where `cost` is a **tier array** of
  `{input, output, cache: {read, write}}` (config's `cache_read/cache_write` normalize into
  `cache.*`). Units are **USD per 1M tokens** (confirmed by reproducing the host arithmetic
  exactly). The 12 listed models were all the built-in `opencode` free provider — **a
  config-defined provider's models did not appear in `model.list()` while actively serving
  traffic**.

## Decision drivers

- Cost must include cache terms (self-hosted and subscription models make cache traffic dominant).
- No trust in host-computed values; parse at the boundary, never build on guessed shapes.
- Must work for config-defined providers, not only catalog models.
- Minimal dependencies; reuse the sibling's layered price resolution.

## Considered options

1. **Trust host `cost`** — rejected: 0 for unpriced models; drops `cache.read` for priced ones.
2. **Parse provider HTTP bodies for usage and cost** — rejected: one-shot stream bodies must be
   teed, formats vary per provider, and OpenCode already normalizes usage better than we would.
3. **Event-stream usage × self-resolved price (chosen)** — `session.step.ended` tokens times a
   price resolved by the plugin.

## Decision

Cost is always **self-computed**: `input×in + output×out + reasoning×out + cache.read×r +
cache.write×w` (USD; reasoning priced at the output rate — host precedent), with prices resolved
per `providerID/modelID` in this precedence:

1. Plugin config override (exact id) — carries over from omp-langfuse.
2. `ctx.model.list()` catalog tier (USD/Mtok; first tier in v0).
3. Bundled table for subscription/zeroed models (sibling's researched rates, e.g. GLM).
4. No match → cost omitted from the observation and a one-time warning emitted per model.

Known limitation (v0): source 2 does not cover config-defined providers (verified gap), so those
resolve via 1 or 4 only until a config-read surface is available. Multi-tier pricing
(`context_over_200k`) has an unverified tier discriminator; v0 uses the first tier and flags it.

## Consequences

- Trace `costDetails` are more complete than the host's own numbers (cache terms included).
- The plugin owns a small pricing table and update burden, as omp-langfuse already does.
- Host `cost` remains recorded as metadata only, never as the displayed cost.

## Confirmation

E2E audit on a priced model: fetch the newest trace and assert `costDetails` equal the
hand-computed value from the resolved tier within float tolerance, including a cache-heavy run;
compare against the host's `cost` field to document the delta.
