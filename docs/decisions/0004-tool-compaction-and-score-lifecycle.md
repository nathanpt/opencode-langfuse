# 0004. Tool observation, compaction span, and score lifecycle

- Status: accepted
- Date: 2026-11-10

## Context

Features 006–008 add root-sibling observations (tool spans, compaction spans) and trace-level
scores to the ADR-0003 trace model. OpenCode v2.0.31 offers three acquisition surfaces with
different guarantees: durable `session.tool.*` / `session.compaction.*` events (totally ordered
per session, no timestamps beyond the envelope `created`), the awaited read-only
`ctx.tool.hook("execute.after")` callback (has native status/result/error, no timestamp), and
transcript reads via `ctx.session.context`. Scores must accumulate across continued prompts,
compactions, flushes, and tracker restarts without persistence (ADR-0001: no new storage; the
plugin runs in the long-lived server process, so warm state is normally cumulative).

## Decision drivers

- Tool calls can fail natively in two ways: the hook reports `status:"error"`, and v2.0.31 can
  report a native `shell` completion (`status:"completed"`) carrying a finite non-zero
  `metadata.exit` (preflight-proven). Output text never determines success.
- Durable tool/compaction facts carry no tool name on terminal events (`session.tool.success` /
  `.failed` lack `name`); pairing must use the full `(sessionID, assistantMessageID, toolCallID)`
  identity, never FIFO.
- Compaction natively guarantees at most one active lifecycle per session (pinned
  `session/compaction.ts`), but one lifecycle may drive zero, one, or many HTTP generations.
- Score history can be lost: a cold load after a completed compaction only exposes the
  post-compaction context window (`history.ts`: messages at `seq >= latest completed compaction`).
  Langfuse rejects score overwrites that would lower totals; guessing a partial window and
  overwriting is worse than omitting.
- No persistence, no new dependencies, no provider-body parsing (project hard constraints).

## Considered options

1. Classify tool failure by output text or by a separate `shell.exited` correlation map —
   rejected: text lies in both directions; correlation maps are FIFO heuristics with exact
   identity fields available.
2. Persist id/counter maps across restarts (`ctx.storage`) — rejected: new storage tier for
   derivable-or-omittable data; ADR-0001 rejects opaque storage for this project.
3. Publish scores from a partial window after a compacted cold load — rejected: overwrites
   cumulative totals with a subwindow; Langfuse upserts would corrupt previously stored scores.
4. Operator-selected rule: hook error status **or** finite non-zero native shell `exit` means
   failure; scores publish only when complete history is provable — **chosen**.

## Decision

- **Tool classification** is exactly
  `nativeStatus === "error" || (name === "shell" && typeof exit === "number" && Number.isFinite(exit) && exit !== 0)`.
  The actual native hook status (`completed`/`error`) is exported separately as
  `metadata.nativeStatus`; the validated numeric exit as `metadata.exitCode`. Success text
  containing "error" stays successful; interruption is never classified as tool error.
- **Observation hierarchy** (extends ADR-0003, which is otherwise unchanged): tool and compaction
  spans are `span-create`/`span-update` events parented directly under the root observation.
  Observation ids are `stableHash` of `opencode-langfuse:tool:<sessionID>:<assistantMessageID>:<toolCallID>`
  (16 hex) and `opencode-langfuse:compaction:<sessionID>:start:<startedSeq>` (16 hex; terminal-only
  spans use a `terminal:<terminalSeq>` suffix). Score body ids are
  `stableHash("opencode-langfuse:score:<sessionID>:<name>", 32)`.
- **Compaction spans** carry identity/reason/boundaries only — no input, output, usage, cost, or
  native summary bytes; one lifecycle per native compaction identity regardless of HTTP traffic.
- **Scores** are cumulative from a complete-history ledger: counts advance once per primary turn
  identity (`assistantMessageID`) and once per tool identity `(assistantMessageID, toolCallID)`.
  A successfully parsed snapshot context with **no completed compaction** may seed the ledger
  (first reconciliation only); a locally observed `session.created` starts complete at zero; a
  failed lookup or compacted prefix starts incomplete. Warm ledgers are never replaced by later
  context reads. When history is incomplete, overflow, or any admitted tool lacks an authoritative
  terminal outcome, all five score updates are omitted (previously stored scores preserved) with
  one bounded warning; observations/root/cost export normally.

## Consequences

- An otherwise-successful native shell invocation with non-zero exit counts as a tool failure for
  both observations and `total_tool_errors` (deliberate operator selection).
- After a compacted cold restore, the trace keeps its observations but gains no new scores;
  scores stay at their previously stored values (possibly absent). This is deliberate, not a
  failing capture path.
- Metadata is whitelisted per observation type; native events/results/errors are never spread
  into payloads, and compaction spans cannot echo summaries through the status-message path
  (fixed status text in every preset).

## Confirmation

- Deterministic: `test/tracker.test.ts` / `test/tools.test.ts` / `test/compactions.test.ts` /
  `test/scores.test.ts` cover classification, pairing, lifecycle, ledger seeding, and omission.
- Native: preflight probe proving `(sessionID, messageID/id)` correspondence and finite
  `metadata.exit` on 2.0.31; per-feature live fixtures in `/tmp/oc-features006-009` exercising
  the built plugin against the loopback recorder + real Langfuse ingestion.
