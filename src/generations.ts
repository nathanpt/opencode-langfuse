/**
 * Generation observation wire contract: one explicit builder per Langfuse
 * GENERATION event, adapted from omp-langfuse's generation handler shape (not
 * its role machinery, matching heuristics, or OTel runtime).
 *
 * This slice captures metadata only — never model input/output, provider
 * request/response bodies, token usage, or cost (features 004/005).
 */

import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import { GENERATION_NAME } from "./constants.js"
import type { IngestEvent } from "./langfuse.js"
import { redactString } from "./redaction.js"

export type GenerationKind = "primary" | "title" | "compaction" | "generate"

export interface ModelReference {
  id: string
  providerID: string
  variant?: string
}

/** Why a generation's wire payload looks the way it does. */
export type CaptureStatus = "running" | "completed" | "error" | "cancelled" | "interrupted" | "unavailable"

export interface GenerationRecord {
  observationId: string
  /** The OpenCode session this generation belongs to (survives as metadata.sessionId). */
  sessionID: string
  kind: GenerationKind
  agent?: string
  model?: ModelReference
  /** Dispatch time (ms epoch): primary step start or auxiliary HTTP dispatch. */
  startTime?: number
  /** Observed response-stream terminal time (ms epoch); never header arrival or export time. */
  endTime?: number
  /** Primary only: the assistant message the request belongs to. */
  assistantMessageID?: string
  finishReason?: string
  /** Auxiliary only: observed HTTP response status. */
  httpStatus?: number
  /** Which observed signal produced endTime; absent when endTime is unknown. */
  endBoundary?: string
  captureStatus: CaptureStatus
  /** Redacted, bounded explanation for error/warning captures. */
  statusMessage?: string
}

export interface SessionIdentity {
  traceId: string
  rootObservationId: string
}

/** Fixed per-capture-status explanations, used when no safe error text is available. */
const STATUS_EXPLANATION: Record<CaptureStatus, string | undefined> = {
  running: undefined,
  completed: undefined,
  error: "provider stream failed",
  cancelled: "response body cancelled by consumer",
  interrupted: "telemetry interrupted before the provider response finished",
  unavailable: "response capture unavailable; exchange admitted without body telemetry",
}

export function generationName(kind: GenerationKind): string {
  return kind === "primary" ? GENERATION_NAME : `${GENERATION_NAME}:${kind}`
}

function levelFor(record: GenerationRecord): "DEFAULT" | "WARNING" | "ERROR" {
  if (record.captureStatus === "error") {
    // Primary/provider errors and auxiliary HTTP >= 400 are both provider errors.
    return "ERROR"
  }
  if (record.captureStatus === "cancelled" || record.captureStatus === "interrupted" || record.captureStatus === "unavailable") {
    return "WARNING"
  }
  return "DEFAULT"
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString()
}

/**
 * Pure builder: one ingestion event for one generation record. Never performs
 * network I/O and never interprets provider payload formats. Create payloads
 * are complete; update payloads only carry fields Langfuse supports updating.
 */
export function buildGenerationEvent(
  record: GenerationRecord,
  parent: SessionIdentity,
  phase: "create" | "update",
  eventID: string,
  emittedAt: number,
  policy: CapturePolicy,
): IngestEvent {
  const metadata: Record<string, unknown> = {
    sessionId: record.sessionID,
    kind: record.kind,
    captureStatus: record.captureStatus,
  }
  if (record.model?.providerID !== undefined) {
    metadata.providerID = record.model.providerID
  }
  if (record.agent !== undefined) {
    metadata.agent = record.agent
  }
  if (record.model?.variant !== undefined) {
    metadata.variant = record.model.variant
  }
  if (record.kind === "primary") {
    if (record.assistantMessageID !== undefined) {
      metadata.assistantMessageID = record.assistantMessageID
    }
    if (record.finishReason !== undefined) {
      metadata.finishReason = record.finishReason
    }
    if (record.endBoundary !== undefined) {
      metadata.endBoundary = record.endBoundary
    }
  } else if (record.httpStatus !== undefined) {
    metadata.httpStatus = record.httpStatus
  }

  const captured = applyCapturePolicy({ metadata }, policy)

  const statusMessage = record.statusMessage ?? STATUS_EXPLANATION[record.captureStatus]

  const body: Record<string, unknown> = {
    id: record.observationId,
    traceId: parent.traceId,
    name: generationName(record.kind),
    metadata: captured.metadata,
    level: levelFor(record),
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
  // Exactly the host's model reference id (e.g. "mock-1") — never a display name,
  // session default, or another request's model.
  if (record.model?.id !== undefined) {
    body.model = record.model.id
  }
  if (statusMessage !== undefined) {
    body.statusMessage = redactString(statusMessage)
  }

  return {
    id: eventID,
    type: phase === "create" ? "generation-create" : "generation-update",
    timestamp: new Date(emittedAt).toISOString(),
    body,
  }
}
