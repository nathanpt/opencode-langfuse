/**
 * Generation observation wire contract: one explicit builder per Langfuse
 * GENERATION event, adapted from omp-langfuse's generation handler shape (not
 * its role machinery, matching heuristics, or OTel runtime).
 *
 * Primary generations carry normalized token usage (`usageDetails`) and the
 * independently computed `costDetails` quote (feature-005) from the durable
 * step events; host cost never substitutes for either — never provider
 * request/response bodies.
 */

import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import { GENERATION_NAME } from "./constants.js"
import type { IngestEvent } from "./langfuse.js"
import type { GenerationPricing } from "./pricing.js"
import { redactString, redactValue } from "./redaction.js"

export type GenerationKind = "primary" | "title" | "compaction" | "generate"

export interface ModelReference {
  id: string
  providerID: string
  variant?: string
}

/** Why a generation's wire payload looks the way it does. */
export type CaptureStatus = "running" | "completed" | "error" | "cancelled" | "interrupted" | "unavailable"

/** Normalized per-request token usage (OpenCode's `session.step.ended` shape). */
export interface GenerationUsage {
  /** Non-cached prompt tokens. */
  input: number
  /** Non-reasoning completion tokens. */
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

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
  /** Primary only: normalized token usage reported by OpenCode for this request. */
  usage?: GenerationUsage
  /** Primary only: the independently computed cost quote; absent when unpriced. */
  pricing?: GenerationPricing
  /** Primary only: host-reported cost — diagnostic metadata, never an arithmetic input. */
  hostCost?: number
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
  if (record.kind === "primary" && record.hostCost !== undefined) {
    // Host cost is diagnostic only (0 for unpriced models, cache terms dropped
    // for priced ones); the exported cost below is computed independently.
    metadata.hostCost = record.hostCost
  }
  if (record.pricing !== undefined) {
    metadata.pricingSource = record.pricing.source
    if (record.pricing.source === "catalog") {
      if (record.pricing.tierCount !== undefined) {
        metadata.pricingTierCount = record.pricing.tierCount
      }
      if (record.pricing.pricingTier !== undefined) {
        metadata.pricingTierType = record.pricing.pricingTier.type
        metadata.pricingTierSize = record.pricing.pricingTier.size
      }
      if (record.pricing.firstTierApproximation) {
        metadata.pricingTierApproximation = "first-tier"
      }
    }
    if (record.pricing.assumption === "off-peak") {
      metadata.pricingAssumption = "off-peak"
    }
  }

  const captured = applyCapturePolicy({ metadata }, policy)

  // Dynamic status text can echo provider/output content: while output
  // capture is off, the fixed per-status explanation is exported instead of
  // the raw message (feature-009). With capture on, the bounded message is
  // redacted like every other emitted string.
  const fixedExplanation = STATUS_EXPLANATION[record.captureStatus]
  const statusMessage = policy.captureOutputs ? (record.statusMessage ?? fixedExplanation) : fixedExplanation

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
  // session default, or another request's model. Dynamic emitted string: passes
  // the redactor like every other exported attribute.
  if (record.model?.id !== undefined) {
    body.model = redactString(record.model.id)
  }
  // Normalized token usage as reported by OpenCode's durable step events; never
  // derived from provider payloads or guessed for requests without step events.
  if (record.usage !== undefined) {
    const u = record.usage
    const usageDetails: Record<string, number> = {
      input: u.input,
      output: u.output,
      total: u.input + u.output + (u.reasoning ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    }
    if (u.reasoning) {
      usageDetails.reasoning = u.reasoning
    }
    if (u.cacheRead) {
      usageDetails.cacheRead = u.cacheRead
    }
    if (u.cacheWrite) {
      usageDetails.cacheWrite = u.cacheWrite
    }
    body.usageDetails = usageDetails
  }
  // Cost is the stored, once-computed quote — no recomputation at export or
  // retry time. Host cost is diagnostic only; the exported manual cost is
  // independently computed from usage and a resolved price (feature-005).
  if (record.pricing !== undefined) {
    const c = record.pricing.costDetails
    const costDetails: Record<string, number> = {}
    if (Number.isFinite(c.input)) {
      costDetails.input = c.input
    }
    if (Number.isFinite(c.output)) {
      costDetails.output = c.output
    }
    if (c.reasoning !== undefined && Number.isFinite(c.reasoning)) {
      costDetails.reasoning = c.reasoning
    }
    if (c.cacheRead !== undefined && Number.isFinite(c.cacheRead)) {
      costDetails.cacheRead = c.cacheRead
    }
    if (c.cacheWrite !== undefined && Number.isFinite(c.cacheWrite)) {
      costDetails.cacheWrite = c.cacheWrite
    }
    if (Number.isFinite(c.total)) {
      costDetails.total = c.total
    }
    if (Object.keys(costDetails).length > 0) {
      body.costDetails = redactValue(costDetails)
    }
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
