/**
 * Tool observation wire contract: one named span per exact tool call
 * (feature-006, ADR-0004). A span is exported only when the native tool name
 * is known; classification follows the operator-selected rule — the hook's
 * native error status or a finite non-zero structured shell exit — never the
 * output text. `input`/`output` on a record are already capture-gated,
 * redacted, detached values; the builder gates again so no preset can leak.
 */

import { createHash } from "node:crypto"
import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import { MAX_STRING_LENGTH, TOOL_SEED_PREFIX } from "./constants.js"
import type { SessionIdentity } from "./generations.js"
import { isRecord } from "./guards.js"
import type { IngestEvent } from "./langfuse.js"
import { redactString } from "./redaction.js"

export type ToolCaptureStatus = "running" | "completed" | "error" | "interrupted"

/** The actual native terminal status (`execute.after` status or durable fact), exported verbatim. */
export type ToolNativeStatus = "completed" | "error"

/** Which observed signal delivered the terminal outcome. */
export type ToolOutcomeSource = "execute.after" | "session.tool.success" | "session.tool.failed"

export type ToolStartBoundary = "session.tool.called" | "transcript.tool.time" | "unavailable"

export type ToolEndBoundary =
  | "execute.after"
  | "session.tool.success"
  | "session.tool.failed"
  | "session.execution.interrupted"
  | "plugin.shutdown"

export interface ToolRecord {
  observationId: string
  sessionID: string
  assistantMessageID: string
  toolCallID: string
  /** Native tool name (e.g. "shell"); unnamed records are never exported. */
  name?: string
  startTime?: number
  endTime?: number
  /** Capture-gated, redacted, detached values — never the caller's objects. */
  input?: unknown
  output?: unknown
  captureStatus: ToolCaptureStatus
  /** Terminal-only provenance fields. */
  nativeStatus?: ToolNativeStatus
  outcomeSource?: ToolOutcomeSource
  /** Validated finite native shell exit code (terminal-only). */
  exitCode?: number
  /** Bounded, redacted native error message (terminal-only). */
  statusMessage?: string
  startBoundary?: ToolStartBoundary
  endBoundary?: ToolEndBoundary
}

/** Deterministic observation id over the exact (session, message, call) identity. */
export function toolObservationId(sessionID: string, assistantMessageID: string, toolCallID: string): string {
  return stableHash(`${TOOL_SEED_PREFIX}${sessionID}:${assistantMessageID}:${toolCallID}`, 16)
}

function stableHash(seed: string, chars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, chars)
}

/**
 * The operator-selected failure rule (ADR-0004): native error status, or a
 * finite non-zero structured shell exit on a call known to be `shell`.
 * Output text never participates; missing/invalid/string exits are ignored.
 */
export function isToolFailure(record: Pick<ToolRecord, "nativeStatus" | "name" | "exitCode">): boolean {
  return (
    record.nativeStatus === "error" ||
    (record.name === "shell" &&
      typeof record.exitCode === "number" &&
      Number.isFinite(record.exitCode) &&
      record.exitCode !== 0)
  )
}

/** The validated numeric exit field: numbers only — strings and other shapes are ignored. */
export function nativeExit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Bounded textual output from tool content: a content string or text parts,
 * incrementally capped at MAX_STRING_LENGTH. File parts and metadata are
 * never read. Returns undefined when no textual content exists.
 */
export function toolOutputText(content: unknown): string | undefined {
  if (typeof content === "string" && content.length > 0) {
    return content.slice(0, MAX_STRING_LENGTH)
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  let text = ""
  for (const part of content) {
    if (text.length >= MAX_STRING_LENGTH) {
      break
    }
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      text += part.text.slice(0, MAX_STRING_LENGTH - text.length)
    }
  }
  return text.length > 0 ? text : undefined
}

/** Capture-gates the final tool input into a detached value (undefined when the preset refuses it). */
export function captureHookToolInput(input: unknown, policy: CapturePolicy): unknown {
  if (input === undefined) {
    return undefined
  }
  return applyCapturePolicy({ toolInput: input }, policy).toolInput
}

/**
 * Capture-gates hook/transcript output: bounded textual content first, then
 * an explicit structured `output` through bounded redaction. Never the whole
 * result object and never result metadata.
 */
export function captureHookToolOutput(result: unknown, policy: CapturePolicy): unknown {
  if (!isRecord(result)) {
    return undefined
  }
  const text = toolOutputText(result.content)
  if (text !== undefined) {
    return applyCapturePolicy({ toolOutput: text }, policy).toolOutput
  }
  if (result.output !== undefined) {
    return applyCapturePolicy({ toolOutput: result.output }, policy).toolOutput
  }
  return undefined
}

const FIXED_TOOL_FAILURE = "tool execution failed"
const FIXED_TOOL_INTERRUPTED = "tool interrupted before completion"

/**
 * Status text is fixed whenever content capture is off, so excluded
 * arguments and native error text can never echo through statusMessage.
 * With capture on, the record's already-bounded/redacted native message is
 * used; shell exits always use the fixed exit explanation.
 */
function toolStatusMessage(record: ToolRecord, policy: CapturePolicy): string | undefined {
  if (record.captureStatus === "interrupted") {
    return FIXED_TOOL_INTERRUPTED
  }
  if (record.captureStatus !== "error") {
    return undefined
  }
  if (record.exitCode !== undefined) {
    return `shell exited with code ${record.exitCode}`
  }
  if (policy.captureToolIo && record.statusMessage !== undefined) {
    return record.statusMessage
  }
  return FIXED_TOOL_FAILURE
}

function levelFor(record: ToolRecord): "DEFAULT" | "WARNING" | "ERROR" {
  if (record.captureStatus === "error") {
    return "ERROR"
  }
  if (record.captureStatus === "interrupted") {
    return "WARNING"
  }
  return "DEFAULT"
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString()
}

/**
 * Pure builder: one span-create/span-update ingestion event for one tool
 * record. Metadata is whitelisted (ADR-0004); payload fields are attached
 * only when observed and permitted — never as properties containing
 * undefined.
 */
export function buildToolEvent(
  record: ToolRecord,
  parent: SessionIdentity,
  phase: "create" | "update",
  eventID: string,
  emittedAt: number,
  policy: CapturePolicy,
): IngestEvent {
  const metadata: Record<string, unknown> = {
    sessionId: record.sessionID,
    kind: "tool",
    assistantMessageID: record.assistantMessageID,
    toolCallID: record.toolCallID,
    captureStatus: record.captureStatus,
  }
  if (record.startBoundary !== undefined) {
    metadata.startBoundary = record.startBoundary
  }
  if (record.endBoundary !== undefined) {
    metadata.endBoundary = record.endBoundary
  }
  if (record.nativeStatus !== undefined) {
    metadata.nativeStatus = record.nativeStatus
  }
  if (record.outcomeSource !== undefined) {
    metadata.outcomeSource = record.outcomeSource
  }
  if (record.exitCode !== undefined) {
    metadata.exitCode = record.exitCode
  }
  // Only terminal outcomes carry the boolean; interruption is not an invented error.
  if (record.captureStatus === "completed" || record.captureStatus === "error") {
    metadata.isError = record.captureStatus === "error"
  }

  const raw: { toolInput?: unknown; toolOutput?: unknown; metadata: Record<string, unknown> } = { metadata }
  if (record.input !== undefined) {
    raw.toolInput = record.input
  }
  if (record.output !== undefined) {
    raw.toolOutput = record.output
  }
  const captured = applyCapturePolicy(raw, policy)

  const body: Record<string, unknown> = {
    id: record.observationId,
    traceId: parent.traceId,
    name: redactString(record.name ?? "tool"),
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
  if (captured.toolInput !== undefined) {
    body.input = captured.toolInput
  }
  if (captured.toolOutput !== undefined) {
    body.output = captured.toolOutput
  }
  const statusMessage = toolStatusMessage(record, policy)
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
