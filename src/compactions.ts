/**
 * Compaction span wire contract: one content-free span per compaction
 * lifecycle (feature-007, ADR-0004). The native source guarantees at most one
 * active compaction per session, but one lifecycle may drive zero, one, or
 * many HTTP generations — none of that traffic changes the span count.
 * Deliberately no input, output, usage, cost, or native summary bytes: status
 * text is fixed in every preset, so native errors cannot echo a summary.
 */

import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import { COMPACTION_SEED_PREFIX } from "./constants.js"
import { createHash } from "node:crypto"
import type { SessionIdentity } from "./generations.js"
import type { IngestEvent } from "./langfuse.js"
import { redactString } from "./redaction.js"

export type CompactionCaptureStatus = "running" | "completed" | "error" | "interrupted"

export type CompactionStartBoundary = "session.compaction.started" | "unavailable"

export type CompactionEndBoundary =
  | "session.compaction.ended"
  | "session.compaction.failed"
  | "session.execution.interrupted"
  | "plugin.shutdown"
  | "next-compaction.started"

export interface CompactionRecord {
  observationId: string
  sessionID: string
  /** Retained only as metadata/correlation evidence; never required. */
  inputID?: string
  reason: "auto" | "manual"
  startTime?: number
  endTime?: number
  captureStatus: CompactionCaptureStatus
  startBoundary?: CompactionStartBoundary
  endBoundary?: CompactionEndBoundary
}

/** Deterministic lifecycle id over the native start sequence. */
export function compactionStartId(sessionID: string, startedSeq: number): string {
  return stableHash(`${COMPACTION_SEED_PREFIX}${sessionID}:start:${startedSeq}`, 16)
}

/** Deterministic id for a terminal observed without its start. */
export function compactionTerminalId(sessionID: string, terminalSeq: number): string {
  return stableHash(`${COMPACTION_SEED_PREFIX}${sessionID}:terminal:${terminalSeq}`, 16)
}

function stableHash(seed: string, chars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, chars)
}

function levelFor(record: CompactionRecord): "DEFAULT" | "WARNING" | "ERROR" {
  if (record.captureStatus === "error") {
    return "ERROR"
  }
  if (record.captureStatus === "interrupted") {
    return "WARNING"
  }
  return "DEFAULT"
}

/** Fixed status text in every preset — native errors can never echo a summary here. */
function statusText(record: CompactionRecord): string | undefined {
  if (record.captureStatus === "error") {
    return "compaction failed"
  }
  if (record.captureStatus === "interrupted") {
    return "compaction interrupted"
  }
  return undefined
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString()
}

/**
 * Pure builder: one span-create/span-update ingestion event for one
 * compaction lifecycle. Metadata carries identity, reason, capture status,
 * and boundaries only.
 */
export function buildCompactionEvent(
  record: CompactionRecord,
  parent: SessionIdentity,
  phase: "create" | "update",
  eventID: string,
  emittedAt: number,
  policy: CapturePolicy,
): IngestEvent {
  const metadata: Record<string, unknown> = {
    sessionId: record.sessionID,
    kind: "compaction",
    reason: record.reason,
    captureStatus: record.captureStatus,
  }
  if (record.inputID !== undefined) {
    metadata.inputID = record.inputID
  }
  if (record.startBoundary !== undefined) {
    metadata.startBoundary = record.startBoundary
  }
  if (record.endBoundary !== undefined) {
    metadata.endBoundary = record.endBoundary
  }
  const captured = applyCapturePolicy({ metadata }, policy)

  const body: Record<string, unknown> = {
    id: record.observationId,
    traceId: parent.traceId,
    name: "compaction",
    level: levelFor(record),
    metadata: captured.metadata,
  }
  if (phase === "create") {
    body.parentObservationId = parent.rootObservationId
  }
  const startTime = toIso(record.startTime)
  if (startTime !== undefined) {
    body.startTime = startTime
  }
  const endTime = toIso(record.endTime)
  if (endTime !== undefined) {
    body.endTime = endTime
  }
  const statusMessage = statusText(record)
  if (statusMessage !== undefined) {
    body.statusMessage = redactString(statusMessage)
  }

  return {
    id: eventID,
    type: phase === "create" ? "span-create" : "span-update",
    timestamp: new Date(emittedAt).toISOString(),
    body,
  }
}
