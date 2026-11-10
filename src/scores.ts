/**
 * Trace-level scores (feature-008, ADR-0004): the sibling's five-score
 * semantics adapted to this tracker — no OTel runtime, no agent-end reset, no
 * extra tool_is_error score. Values are cumulative and publish only when the
 * complete history is provable; an incomplete or unresolved snapshot omits
 * all five updates rather than overwriting stored totals with a partial
 * window.
 */

import { SCORE_SEED_PREFIX } from "./constants.js"
import { createHash } from "node:crypto"
import type { IngestEvent } from "./langfuse.js"

export interface ScoreCounts {
  /** Unique admitted tool calls. */
  readonly toolCallCount: number
  /** Unique primary assistant request identities, including failed requests. */
  readonly turnCount: number
  /** Unique tool failures under the selected classification rule. */
  readonly toolErrorCount: number
}

export type ScoreName =
  | "tool_call_count"
  | "turn_count"
  | "total_tool_errors"
  | "tool_success_rate"
  | "session_had_errors"

export const SCORE_NAMES: readonly ScoreName[] = [
  "tool_call_count",
  "turn_count",
  "total_tool_errors",
  "tool_success_rate",
  "session_had_errors",
]

/**
 * The sibling's fixed value semantics: turns are primary model iterations,
 * the success rate is 1 for zero tools, and session_had_errors is
 * tools-only (provider errors never flip it).
 */
export function computeScores(counts: ScoreCounts): Readonly<Record<ScoreName, number>> {
  const toolSuccessRate =
    counts.toolCallCount > 0 ? (counts.toolCallCount - counts.toolErrorCount) / counts.toolCallCount : 1
  return {
    tool_call_count: counts.toolCallCount,
    turn_count: counts.turnCount,
    total_tool_errors: counts.toolErrorCount,
    tool_success_rate: toolSuccessRate,
    session_had_errors: counts.toolErrorCount > 0 ? 1 : 0,
  }
}

/** Stable 32-hex score body id per (session, name). */
export function scoreId(sessionID: string, name: ScoreName): string {
  return stableHash(`${SCORE_SEED_PREFIX}${sessionID}:${name}`, 32)
}

function stableHash(seed: string, chars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, chars)
}

/**
 * Pure builder: one score-create ingestion event. No
 * observationId/sessionId/comment/content and no new endpoint — the ordered
 * session batch carries it like every other event.
 */
export function buildScoreEvent(
  name: ScoreName,
  value: number,
  traceId: string,
  scoreID: string,
  eventID: string,
  emittedAt: number,
): IngestEvent {
  return {
    id: eventID,
    type: "score-create",
    timestamp: new Date(emittedAt).toISOString(),
    body: {
      id: scoreID,
      traceId,
      name,
      value,
      dataType: name === "session_had_errors" ? "BOOLEAN" : "NUMERIC",
    },
  }
}

/** One recovered tool fact: identity + terminal outcome, nothing else. */
export interface ScoreSeedTool {
  assistantMessageID: string
  toolCallID: string
  name: string
  status: "running" | "completed" | "error"
  exit?: number
}

/**
 * Recovered score history from one transcript read. It carries identities and
 * terminal outcomes only — no prompt/tool payloads, errors, summaries, or
 * model settings. Streaming-only tool parts are not admitted calls and never
 * appear here.
 */
export type ScoreHistorySnapshot =
  | { complete: false }
  | {
      complete: true
      turns: readonly string[]
      tools: readonly ScoreSeedTool[]
    }
