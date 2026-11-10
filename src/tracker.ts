/**
 * Per-session trace state, generation acquisition, and export lifetime.
 *
 * One trace per OpenCode session: child sessions (subagents) are admitted
 * like primaries and export their own trace/root named
 * `opencode-subagent:<agent>`, grouped under the direct parent's Langfuse
 * session id and linked by trace metadata (feature-013). Identity is
 * deterministic from the session id, so a continued, flushed, or
 * reconstructed session reuses the same trace/root/generation ids. The
 * durable event stream is the only truth for primaries
 * (`session.step.*`, `session.execution.*`, prompts, final assistant text);
 * auxiliary exchanges (title/compaction/generate) arrive through exact
 * Request-identity HTTP hooks. State work is serialized per session and never
 * awaited from the event path; exports run on their own per-session chain.
 */

import { createHash, randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { observeAuxiliaryResponse, type AuxiliaryCompletion, type ObservedAuxiliaryResponse } from "./auxiliary.js"
import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import {
  FLUSH_GRACE_MS,
  GENERATION_SEED_PREFIX,
  LANGFUSE_SESSION_ID_MAX,
  MAX_PENDING_COMPACTIONS_PER_SESSION,
  MAX_PENDING_GENERATIONS_PER_SESSION,
  MAX_PENDING_TOOLS_PER_SESSION,
  MAX_SCORE_FACTS_PER_SESSION,
  MAX_STRING_LENGTH,
  MAX_TRACKED_SESSIONS,
  ROOT_SEED_PREFIX,
  SHUTDOWN_TIMEOUT_MS,
  SUBAGENT_TRACE_NAME_PREFIX,
  TRACE_NAME,
  TRACE_SEED_PREFIX,
} from "./constants.js"
import {
  buildGenerationEvent,
  type GenerationKind,
  type GenerationRecord,
  type ModelReference,
  type SessionIdentity,
} from "./generations.js"
import type { IngestEvent, LangfuseTransport } from "./langfuse.js"
import { isRecord } from "./guards.js"
import type { PricingResolver } from "./pricing.js"
import { redactValue } from "./redaction.js"
import type { SourceMetadata } from "./source-metadata.js"
import {
  buildToolEvent,
  captureHookToolInput,
  captureHookToolOutput,
  isToolFailure,
  nativeExit,
  toolObservationId,
  toolOutputText,
  type ToolEndBoundary,
  type ToolRecord,
} from "./tools.js"
import {
  buildCompactionEvent,
  compactionStartId,
  compactionTerminalId,
  type CompactionEndBoundary,
  type CompactionRecord,
} from "./compactions.js"
import {
  buildScoreEvent,
  computeScores,
  SCORE_NAMES,
  scoreId,
  type ScoreCounts,
  type ScoreHistorySnapshot,
  type ScoreName,
} from "./scores.js"

const finiteNumber = z.number().finite()

const modelRefSchema = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().optional(),
})

const envelopeSchema = z.object({
  type: z.string(),
  created: finiteNumber,
  id: z.string().optional(),
  durable: z
    .object({
      aggregateID: z.string(),
      seq: z.number().int(),
      version: z.number().int(),
    })
    .optional(),
  data: z.unknown().optional(),
})

const stepStartedSchema = z.object({
  sessionID: z.string().min(1),
  assistantMessageID: z.string().min(1),
  agent: z.string(),
  model: modelRefSchema,
  started: finiteNumber.optional(),
})

const stepKeySchema = z.object({
  sessionID: z.string().min(1),
  assistantMessageID: z.string().min(1),
})

const stepEndedSchema = stepKeySchema.and(
  z.object({
    finish: z.string(),
    // Host-reported cost: diagnostic metadata only, never trusted (ADR-0002).
    // Parsed defensively so an invalid value never rejects the event.
    cost: z.unknown().optional(),
    tokens: z.object({
      input: finiteNumber,
      output: finiteNumber,
      reasoning: finiteNumber,
      cache: z.object({ read: finiteNumber, write: finiteNumber }),
    }),
  }),
)

const stepFailedSchema = stepKeySchema.and(
  z.object({
    error: z
      .object({ message: z.string().optional() })
      .loose()
      .optional(),
    // Host-reported cost: diagnostic metadata only, never trusted (ADR-0002).
    // Parsed defensively so an invalid value never rejects the event.
    cost: z.unknown().optional(),
    tokens: z
      .object({
        input: finiteNumber,
        output: finiteNumber,
        reasoning: finiteNumber,
        cache: z.object({ read: finiteNumber, write: finiteNumber }),
      })
      .optional(),
  }),
)

const inboxEnqueuedSchema = z.object({
  sessionID: z.string().min(1),
  item: z
    .object({
      type: z.string(),
      payload: z
        .object({ text: z.string().optional() })
        .loose()
        .optional(),
    })
    .loose()
    .optional(),
})

const textEndedSchema = z.object({
  sessionID: z.string().min(1),
  text: z.string(),
})

const executionFailedSchema = z.object({
  sessionID: z.string().min(1),
  error: z
    .object({ message: z.string().optional() })
    .loose()
    .optional(),
})

const executionInterruptedSchema = z.object({
  sessionID: z.string().min(1),
  reason: z.string().optional(),
})

const executionStartedSchema = z.object({
  sessionID: z.string().min(1),
})

const toolKeyDataSchema = z.object({
  sessionID: z.string().min(1),
  assistantMessageID: z.string().min(1),
  id: z.string().min(1),
})

const toolInputStartedSchema = toolKeyDataSchema.and(
  z.object({
    name: z.string().min(1),
  }),
)

const toolCalledSchema = toolKeyDataSchema.and(
  z.object({
    input: z.unknown().optional(),
    // `executed` is not a success flag (observed successful calls carry false); parsed and ignored.
    executed: z.boolean().optional(),
  }),
)

const toolTerminalMetadataSchema = z.record(z.string(), z.unknown()).optional()

const toolSuccessSchema = toolKeyDataSchema.and(
  z.object({
    content: z.unknown().optional(),
    metadata: toolTerminalMetadataSchema,
  }),
)

const toolFailedSchema = toolKeyDataSchema.and(
  z.object({
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose(),
    metadata: toolTerminalMetadataSchema,
  }),
)

/** Awaited `ctx.tool.hook("execute.after")` receipt, parsed defensively at the boundary. */
const toolAfterSchema = z.object({
  tool: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  id: z.string().min(1),
  input: z.unknown().optional(),
  status: z.enum(["completed", "error"]),
  result: z.unknown().optional(),
  error: z
    .object({ message: z.string().optional() })
    .loose()
    .optional(),
})

// Compaction lifecycle: only sessionID, reason, optional inputID, and the
// structured error type are read. Native error message/summary/text/recent/
// providerContext/native/usage/cost fields are deliberately ignored — no
// compaction content is ever captured.
const compactionStartedSchema = z.object({
  sessionID: z.string().min(1),
  reason: z.enum(["auto", "manual"]),
  inputID: z.string().optional(),
})

const compactionEndedSchema = z.object({
  sessionID: z.string().min(1),
  reason: z.enum(["auto", "manual"]),
})

const compactionFailedSchema = z.object({
  sessionID: z.string().min(1),
  reason: z.enum(["auto", "manual"]),
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose(),
  inputID: z.string().optional(),
})

export interface SessionSnapshot {
  parentID?: string
  /** The session's own working directory (nonempty absolute path only). */
  directory?: string
  /** The session's agent name (nonempty only), native birth or Session.Info. */
  agent?: string
  createdAt?: number
  firstPrompt?: string
  latestAssistantOutput?: string
  /** Recovered score-fact identities from the same transcript read (feature-008). */
  scoreHistory?: ScoreHistorySnapshot
}

export interface AssistantSnapshot {
  id: string
  agent: string
  model: ModelReference
  createdAt: number
  streamedAt?: number
  completedAt?: number
  finish?: string
  errorMessage?: string
}

/** One exact tool-call part recovered from the transcript (feature-006 lookupTool). */
export interface ToolSnapshot {
  name: string
  input?: unknown
  output?: unknown
  status: "running" | "completed" | "error"
  exit?: number
  errorMessage?: string
  startedAt?: number
  completedAt?: number
}

export interface TrackerOptions {
  transport: LangfuseTransport
  policy: CapturePolicy
  /** Self-computed cost (feature-005); one resolver per plugin lifetime. */
  pricing: PricingResolver
  flushDelayMs?: number
  shutdownTimeoutMs?: number
  newId?: () => string
  now?: () => number
  log?: (message: string) => void
  /** Plugin runtime-error notice from diagnostics, failed persists, and the shutdown drain (feature-012). */
  onError?: (message: string) => void
  /** Cold-load reconciliation: children are admitted like primaries; failure fails open. */
  lookupSession?(sessionID: string): Promise<SessionSnapshot | undefined>
  /** Bounded collection of source facts for a session's own directory (feature-011). */
  lookupSourceMetadata?(directory: string): Promise<SourceMetadata>
  /** Targeted recovery of one missing primary start from the transcript. */
  lookupAssistant?(sessionID: string, assistantMessageID: string): Promise<AssistantSnapshot | undefined>
  /** Targeted recovery of one missing tool name/start from the exact transcript tool part. */
  lookupTool?(sessionID: string, assistantMessageID: string, toolCallID: string): Promise<ToolSnapshot | undefined>
}

export interface AuxiliaryRequestInfo {
  sessionID: string
  agent?: string
  model: ModelReference
  kind: Exclude<GenerationKind, "primary">
  request: Request
}

export interface AuxiliaryResponseInfo {
  sessionID: string
  agent?: string
  model: ModelReference
  kind: Exclude<GenerationKind, "primary">
  request: Request
  response: Response
}

export interface Tracker {
  /** Parses one native event and enqueues its per-session state work. */
  handleEvent(event: unknown): Promise<void>
  /** Admits one auxiliary HTTP exchange (Request-identified). */
  startAuxiliary(info: AuxiliaryRequestInfo): void
  /** Pairs a response with its request's descriptor and wraps the body. */
  observeAuxiliaryResponse(info: AuxiliaryResponseInfo): Response
  /**
   * Validates and captures one read-only `execute.after` receipt; enqueues
   * per-session work. Never throws into the tool pipeline, mutates the
   * payload, or awaits session reconciliation/ingestion.
   */
  handleToolAfter(event: unknown): void
  flushNow(sessionID: string): Promise<void>
  flushAll(): Promise<void>
  pendingSessionIds(): string[]
  /** Final bounded shutdown: detaches observers, marks unfinished work, drains exports. */
  shutdown(): Promise<void>
}

interface GenEntry {
  record: GenerationRecord
  dirty: boolean
  createExported: boolean
  /** Transcript streamed time recovered alongside a missing start. */
  recoveredStreamedAt?: number
}

interface ToolEntry {
  record: ToolRecord
  dirty: boolean
  createExported: boolean
  /** A called/after/terminal fact admitted this identity as an executed call. */
  admitted: boolean
  /** An execute.after hook receipt was merged into this entry. */
  hookSeen: boolean
  /** A terminal outcome (hook or durable fact) was recorded. */
  terminalSeen: boolean
  /** Name-hint/transcript recovery for a missing name or start was attempted. */
  lookedUp: boolean
  /** endTime came from the hook's tagged fallback; a durable terminal may replace it. */
  endFromHookFallback: boolean
}

interface CompactionEntry {
  record: CompactionRecord
  dirty: boolean
  createExported: boolean
  /** A native terminal fact (or plugin-side interruption) closed this lifecycle. */
  closed: boolean
}

interface SessionState {
  sessionID: string
  identity: SessionIdentity
  createdAt?: number
  firstPrompt?: string
  latestAssistantOutput?: string
  /** Trustworthy session directory from native facts, once known. */
  directory?: string
  /** Detached sanitized source facts, collected once per admission (feature-011). */
  sourceMetadata?: SourceMetadata
  sourceMetadataAttempted?: boolean
  /** Direct parent session id when native sources identify a child (feature-013). */
  parentID?: string
  /** Redacted, bounded subagent name for child traces (feature-013). */
  agent?: string
  rootDirty: boolean
  rootExported: boolean
  rootEndedAt?: number
  observedChildTerminalMax?: number
  generations: Map<string, GenEntry>
  refusedGenerations: Set<string>
  capacityWarned: boolean
  tools: Map<string, ToolEntry>
  /** Name hints from session.tool.input.started, keyed by `${assistantMessageID}\u0000${toolCallID}`. */
  toolNames: Map<string, string>
  refusedTools: Set<string>
  toolCapacityWarned: boolean
  compactions: Map<string, CompactionEntry>
  /** The one lifecycle currently open (native single-compaction guarantee). */
  activeCompaction?: { observationId: string; startedSeq: number; reason: "auto" | "manual" }
  refusedCompactions: Set<string>
  compactionCapacityWarned: boolean
  /** Score-fact ledger: identity sets + incremental counts, seeded at first reconciliation only. */
  ledger?: ScoreLedger
  ledgerSeeded: boolean
  scoreOmissionWarned: boolean
  executionActive: boolean
  executionTerminalSeen: boolean
  scoresDirty: boolean
  publishedScores?: ScoreCounts
  exportTimer?: ReturnType<typeof setTimeout>
  exportDeadline?: number
  exporting: boolean
  lastActiveAt: number
  seenDurableSeqs: Set<number>
  seenEventIds: Set<string>
}

type ToolScoreOutcome = "pending" | "completed" | "error"

interface ScoreLedger {
  /** True when the complete history is provable; false never becomes true later. */
  complete: boolean
  turns: Set<string>
  tools: Map<string, ToolScoreOutcome>
  toolErrorCount: number
  /** Exact deduplication was lost; score updates are suppressed from here on. */
  overflow: boolean
}

interface AuxDescriptor {
  observationId: string
  sessionID: string
  kind: Exclude<GenerationKind, "primary">
  agent?: string
  model: ModelReference
  dispatchAt: number
  httpStatus?: number
  terminal?: AuxiliaryCompletion
  admitted: boolean
  observed?: ObservedAuxiliaryResponse
}

const SELECTED_EVENT_TYPES: Record<string, true> = {
  "session.created": true,
  "session.inbox.enqueued": true,
  "session.text.ended": true,
  "session.execution.started": true,
  "session.execution.succeeded": true,
  "session.execution.failed": true,
  "session.execution.interrupted": true,
  "session.step.started": true,
  "session.step.streamed": true,
  "session.step.ended": true,
  "session.step.failed": true,
  "session.tool.input.started": true,
  "session.tool.called": true,
  "session.tool.success": true,
  "session.tool.failed": true,
  "session.compaction.started": true,
  "session.compaction.ended": true,
  "session.compaction.failed": true,
}

const MAX_SEEN_SEQS = 8192
const DIAGNOSTIC_LIMIT = 300

function noop(): void {}

function stableHash(seed: string, chars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, chars)
}

function isFiniteMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString()
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value
}

/**
 * Host-reported cost is diagnostic metadata only (ADR-0002): accepted when
 * finite and nonnegative, ignored otherwise — an invalid value never rejects
 * otherwise valid tokens or terminal state.
 */
function diagnosticHostCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Nonempty absolute directory from a native birth payload only. */
function birthDirectory(data: Record<string, unknown>): string | undefined {
  const location = isRecord(data.location) ? data.location : undefined
  const directory = location?.directory
  return typeof directory === "string" && directory.length > 0 && isAbsolute(directory) ? directory : undefined
}

/**
 * Child trace label (feature-013): the agent name passes the redactor, then
 * every character outside `[A-Za-z0-9._-]` becomes `_`, capped at 120.
 * Empty/all-underscore results use the fixed `subagent` fallback.
 */
function subagentLabel(agent: string | undefined): string {
  const sanitized =
    typeof agent === "string"
      ? String(redactValue(agent))
          .replace(/[^A-Za-z0-9._-]/g, "_")
          .slice(0, 120)
      : ""
  return sanitized.length === 0 || /^_+$/.test(sanitized) ? "subagent" : sanitized
}

/** Limits + redaction applied before recovered root content is retained. */
function boundRecovered(value: string): string {
  return truncate(value, MAX_STRING_LENGTH)
}

export function createTracker(options: TrackerOptions): Tracker {
  const transport = options.transport
  const policy = options.policy
  const pricing = options.pricing
  const flushDelayMs = options.flushDelayMs ?? FLUSH_GRACE_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const newId = options.newId ?? randomUUID
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string) => console.warn(`📊 Langfuse: ${message}`))
  const lookupSession = options.lookupSession
  const lookupSourceMetadata = options.lookupSourceMetadata
  const lookupAssistant = options.lookupAssistant
  const lookupTool = options.lookupTool
  const onError = options.onError

  /**
   * A diagnostic is a plugin runtime error (lookup failures, malformed
   * payloads, failed persists): it goes to the log and to the retained
   * last-error slot. Capacity/pricing/score-omission warnings use `log()`
   * directly and never record. Observer failures must not alter delivery.
   */
  function diagnostic(message: string): void {
    const text = truncate(String(redactValue(message)), DIAGNOSTIC_LIMIT)
    log(text)
    try {
      onError?.(text)
    } catch {
      // Swallowed: the observer can never change acceptance or cleanup.
    }
  }

  const states = new Map<string, SessionState>()
  const stateChains = new Map<string, Promise<void>>()
  const exportChains = new Map<string, Promise<void>>()
  const sessionCapacityWarned = new Set<string>()
  // Queued-but-unfinished state work per session, tracked outside the state
  // record so pre-state enqueues and in-flight reconciles are never mistaken
  // for clean inactive sessions.
  const pendingWorkBySession = new Map<string, number>()
  const auxByRequest = new WeakMap<Request, AuxDescriptor>()
  const liveAux = new Set<AuxDescriptor>()

  let closed = false
  let shutdownPromise: Promise<void> | undefined

  function sessionIdentity(sessionID: string): SessionIdentity {
    return {
      traceId: stableHash(`${TRACE_SEED_PREFIX}${sessionID}`, 32),
      rootObservationId: stableHash(`${ROOT_SEED_PREFIX}${sessionID}`, 16),
    }
  }

  function primaryObservationId(sessionID: string, assistantMessageID: string): string {
    return stableHash(`${GENERATION_SEED_PREFIX}${sessionID}:${assistantMessageID}`, 16)
  }

  function pendingGenerationCount(st: SessionState): number {
    let count = 0
    for (const entry of st.generations.values()) {
      if (entry.dirty || entry.record.captureStatus === "running") {
        count += 1
      }
    }
    return count
  }

  /** Admitted, unsettled/unexported tool calls: exactly what the per-session cap protects. */
  function pendingToolCount(st: SessionState): number {
    let count = 0
    for (const entry of st.tools.values()) {
      if (entry.admitted && (entry.dirty || entry.record.captureStatus === "running")) {
        count += 1
      }
    }
    return count
  }

  /** Retained, not-yet-exported compaction lifecycles. */
  function pendingCompactionCount(st: SessionState): number {
    let count = 0
    for (const entry of st.compactions.values()) {
      if (entry.dirty) {
        count += 1
      }
    }
    return count
  }

  function isCleanInactive(st: SessionState): boolean {
    return (
      !st.rootDirty &&
      !st.scoresDirty &&
      !st.exporting &&
      (pendingWorkBySession.get(st.sessionID) ?? 0) === 0 &&
      pendingGenerationCount(st) === 0 &&
      pendingToolCount(st) === 0 &&
      pendingCompactionCount(st) === 0
    )
  }

  function forgetSession(st: SessionState): void {
    if (st.exportTimer !== undefined) {
      clearTimeout(st.exportTimer)
      st.exportTimer = undefined
    }
    states.delete(st.sessionID)
    stateChains.delete(st.sessionID)
    exportChains.delete(st.sessionID)
    pendingWorkBySession.delete(st.sessionID)
  }

  function evictLRUCleanInactive(): boolean {
    let victim: SessionState | undefined
    for (const st of states.values()) {
      if (!isCleanInactive(st)) {
        continue
      }
      if (victim === undefined || st.lastActiveAt < victim.lastActiveAt) {
        victim = st
      }
    }
    if (victim === undefined) {
      return false
    }
    forgetSession(victim)
    return true
  }

  function admitSession(sessionID: string): SessionState | undefined {
    const existing = states.get(sessionID)
    if (existing) {
      return existing
    }
    if (states.size >= MAX_TRACKED_SESSIONS) {
      evictLRUCleanInactive()
    }
    if (states.size >= MAX_TRACKED_SESSIONS) {
      if (!sessionCapacityWarned.has(sessionID)) {
        sessionCapacityWarned.add(sessionID)
        log(`Generation telemetry refused for session ${sessionID}: tracked session capacity reached`)
      }
      return undefined
    }
    const st: SessionState = {
      sessionID,
      identity: sessionIdentity(sessionID),
      rootDirty: false,
      rootExported: false,
      generations: new Map(),
      refusedGenerations: new Set(),
      capacityWarned: false,
      tools: new Map(),
      toolNames: new Map(),
      refusedTools: new Set(),
      toolCapacityWarned: false,
      compactions: new Map(),
      refusedCompactions: new Set(),
      compactionCapacityWarned: false,
      ledgerSeeded: false,
      scoreOmissionWarned: false,
      executionActive: false,
      executionTerminalSeen: false,
      scoresDirty: false,
      exporting: false,
      lastActiveAt: now(),
      seenDurableSeqs: new Set(),
      seenEventIds: new Set(),
    }
    states.set(sessionID, st)
    sessionCapacityWarned.delete(sessionID)
    return st
  }

  function admitGeneration(st: SessionState, observationId: string): boolean {
    if (st.refusedGenerations.has(observationId)) {
      return false
    }
    if (pendingGenerationCount(st) >= MAX_PENDING_GENERATIONS_PER_SESSION) {
      if (!st.capacityWarned) {
        st.capacityWarned = true
        log(`Generation telemetry refused for session ${st.sessionID}: pending generation capacity reached`)
      }
      st.refusedGenerations.add(observationId)
      return false
    }
    return true
  }

  function admitTool(st: SessionState, observationId: string): boolean {
    if (st.refusedTools.has(observationId)) {
      return false
    }
    if (pendingToolCount(st) >= MAX_PENDING_TOOLS_PER_SESSION) {
      if (!st.toolCapacityWarned) {
        st.toolCapacityWarned = true
        log(`Tool telemetry refused for session ${st.sessionID}: pending tool capacity reached`)
      }
      st.refusedTools.add(observationId)
      return false
    }
    return true
  }

  function admitCompaction(st: SessionState, observationId: string): boolean {
    if (st.refusedCompactions.has(observationId)) {
      return false
    }
    if (pendingCompactionCount(st) >= MAX_PENDING_COMPACTIONS_PER_SESSION) {
      if (!st.compactionCapacityWarned) {
        st.compactionCapacityWarned = true
        log(`Compaction telemetry refused for session ${st.sessionID}: pending compaction capacity reached`)
      }
      st.refusedCompactions.add(observationId)
      return false
    }
    return true
  }

  /** Resets a refusal episode once capacity is available again. */
  function resetCapacityEpisode(st: SessionState): void {
    if (pendingGenerationCount(st) < MAX_PENDING_GENERATIONS_PER_SESSION) {
      st.capacityWarned = false
      st.refusedGenerations.clear()
    }
    if (pendingToolCount(st) < MAX_PENDING_TOOLS_PER_SESSION) {
      st.toolCapacityWarned = false
      st.refusedTools.clear()
    }
    if (pendingCompactionCount(st) < MAX_PENDING_COMPACTIONS_PER_SESSION) {
      st.compactionCapacityWarned = false
      st.refusedCompactions.clear()
    }
  }

  function pruneSettledGenerations(st: SessionState): void {
    if (st.generations.size <= MAX_PENDING_GENERATIONS_PER_SESSION) {
      return
    }
    const removable = [...st.generations.entries()]
      .filter(([, entry]) => !entry.dirty && entry.record.captureStatus !== "running")
      .sort((a, b) => (a[1].record.startTime ?? 0) - (b[1].record.startTime ?? 0))
    let overflow = st.generations.size - MAX_PENDING_GENERATIONS_PER_SESSION
    for (const [id] of removable) {
      if (overflow <= 0) {
        break
      }
      st.generations.delete(id)
      overflow -= 1
    }
  }

  function pruneSettledTools(st: SessionState): void {
    if (st.tools.size <= MAX_PENDING_TOOLS_PER_SESSION) {
      return
    }
    const removable = [...st.tools.entries()]
      .filter(([, entry]) => !entry.dirty && entry.record.captureStatus !== "running")
      .sort((a, b) => (a[1].record.startTime ?? 0) - (b[1].record.startTime ?? 0))
    let overflow = st.tools.size - MAX_PENDING_TOOLS_PER_SESSION
    for (const [id] of removable) {
      if (overflow <= 0) {
        break
      }
      st.tools.delete(id)
      overflow -= 1
    }
  }

  function pruneSettledCompactions(st: SessionState): void {
    if (st.compactions.size <= MAX_PENDING_COMPACTIONS_PER_SESSION) {
      return
    }
    const removable = [...st.compactions.entries()]
      .filter(([, entry]) => !entry.dirty && entry.closed)
      .sort((a, b) => (a[1].record.startTime ?? 0) - (b[1].record.startTime ?? 0))
    let overflow = st.compactions.size - MAX_PENDING_COMPACTIONS_PER_SESSION
    for (const [id] of removable) {
      if (overflow <= 0) {
        break
      }
      st.compactions.delete(id)
      overflow -= 1
    }
  }

  function enqueueState<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
    const prev = stateChains.get(sessionID) ?? Promise.resolve()
    pendingWorkBySession.set(sessionID, (pendingWorkBySession.get(sessionID) ?? 0) + 1)
    const st = states.get(sessionID)
    if (st) {
      st.lastActiveAt = now()
    }
    const result = prev.then(task, task).finally(() => {
      const remaining = (pendingWorkBySession.get(sessionID) ?? 1) - 1
      if (remaining <= 0) {
        pendingWorkBySession.delete(sessionID)
      } else {
        pendingWorkBySession.set(sessionID, remaining)
      }
    })
    stateChains.set(sessionID, result.then(noop, noop))
    return result
  }

  function requestExport(st: SessionState): void {
    st.lastActiveAt = now()
    if (closed || st.exportTimer !== undefined) {
      return
    }
    const deadline = st.exportDeadline ?? now() + flushDelayMs
    st.exportDeadline = deadline
    const wait = Math.max(0, deadline - now())
    st.exportTimer = setTimeout(() => {
      st.exportTimer = undefined
      void runExportChain(st.sessionID).catch(noop)
    }, wait)
    st.exportTimer.unref?.()
  }

  function runExportChain(sessionID: string, signal?: AbortSignal): Promise<void> {
    const prev = exportChains.get(sessionID) ?? Promise.resolve()
    const next = prev.then(() => exportNow(sessionID, signal))
    exportChains.set(sessionID, next.catch(noop))
    return next
  }

  function markRootRecovered(st: SessionState, snapshot: SessionSnapshot | undefined, eventCreated: number): void {
    if (isFiniteMs(snapshot?.createdAt) && st.createdAt === undefined) {
      st.createdAt = snapshot.createdAt
    } else if (st.createdAt === undefined) {
      st.createdAt = eventCreated
    }
    if (typeof snapshot?.directory === "string" && st.directory === undefined) {
      st.directory = snapshot.directory
    }
    if (typeof snapshot?.parentID === "string" && mergeParentFact(st, snapshot.parentID, "session.info")) {
      st.rootDirty = true
    }
    if (mergeAgentFact(st, snapshot?.agent)) {
      st.rootDirty = true
    }
    if (snapshot?.firstPrompt !== undefined && st.firstPrompt === undefined) {
      st.firstPrompt = boundRecovered(snapshot.firstPrompt)
    }
    if (snapshot?.latestAssistantOutput !== undefined && st.latestAssistantOutput === undefined) {
      st.latestAssistantOutput = boundRecovered(snapshot.latestAssistantOutput)
    }
  }

  /** Redacted, bounded agent name retained on child state. */
  function boundedAgentName(value: string): string {
    return truncate(String(redactValue(value)), 120)
  }

  /**
   * First known nonempty parent wins; a self reference is ignored and a
   * conflict diagnoses without reparenting (feature-013).
   */
  function mergeParentFact(st: SessionState, candidate: string, source: string): boolean {
    if (candidate.length === 0) {
      return false
    }
    if (candidate === st.sessionID) {
      diagnostic(`session ${st.sessionID} reported itself as its own parent (${source}); ignored`)
      return false
    }
    if (st.parentID === undefined) {
      st.parentID = candidate
      return true
    }
    if (st.parentID !== candidate) {
      diagnostic(`session ${st.sessionID} parent conflict: keeping ${st.parentID}, ignoring ${candidate} (${source})`)
    }
    return false
  }

  /** Missing values never erase an established name. */
  function mergeAgentFact(st: SessionState, candidate: string | undefined): boolean {
    if (typeof candidate !== "string" || candidate.length === 0 || st.agent !== undefined) {
      return false
    }
    st.agent = boundedAgentName(candidate)
    return true
  }

  /** Native birth facts enrich a state without erasing known values. */
  function mergeBirthFacts(
    st: SessionState,
    birth: Pick<SessionSnapshot, "directory" | "parentID" | "agent"> | undefined,
  ): boolean {
    let changed = false
    if (st.directory === undefined && typeof birth?.directory === "string" && birth.directory.length > 0) {
      st.directory = birth.directory
      changed = true
    }
    if (typeof birth?.parentID === "string" && mergeParentFact(st, birth.parentID, "session.created")) {
      changed = true
    }
    if (mergeAgentFact(st, birth?.agent)) {
      changed = true
    }
    return changed
  }

  /**
   * Lazy, once-per-admission source-metadata collection (feature-011): runs
   * inside this session's state chain, before its next root export is
   * scheduled; the detached sanitized result is reused on every trace upsert.
   * A reconstructed state recollects current repository facts.
   */
  async function ensureSourceMetadata(st: SessionState): Promise<void> {
    if (
      lookupSourceMetadata === undefined ||
      st.sourceMetadataAttempted ||
      st.sourceMetadata !== undefined ||
      st.directory === undefined
    ) {
      return
    }
    st.sourceMetadataAttempted = true
    try {
      const metadata = await lookupSourceMetadata(st.directory)
      if (closed) {
        return
      }
      st.sourceMetadata = metadata
      st.rootDirty = true
      requestExport(st)
    } catch (error) {
      diagnostic(`source metadata collection failed for session ${st.sessionID}: ${String(error)}`)
    }
  }

  /** Cold-load reconciliation; runs inside the per-session state chain. */
  async function reconcile(
    sessionID: string,
    eventCreated: number,
    allowCreate: boolean,
    origin?: "session.created",
    birth?: Pick<SessionSnapshot, "directory" | "parentID" | "agent">,
  ): Promise<SessionState | undefined> {
    const existing = states.get(sessionID)
    if (existing) {
      // Positive native facts enrich a state created from a failed earlier
      // lookup; missing values never erase known facts.
      if (mergeBirthFacts(existing, birth)) {
        existing.rootDirty = true
        requestExport(existing)
      }
      await ensureSourceMetadata(existing)
      return existing
    }
    let snapshot: SessionSnapshot | undefined
    try {
      snapshot = await lookupSession?.(sessionID)
    } catch (error) {
      diagnostic(`failed session lookup for ${sessionID} (treating as primary): ${String(error)}`)
      snapshot = undefined
    }
    // A lookup completing after shutdown must not recreate records or restart
    // timers; work accepted before shutdown still finishes.
    if (closed && !allowCreate) {
      return undefined
    }
    const st = admitSession(sessionID)
    if (!st) {
      return undefined
    }
    mergeBirthFacts(st, birth)
    markRootRecovered(st, snapshot, eventCreated)
    if (!st.ledgerSeeded) {
      st.ledgerSeeded = true
      // A locally observed session birth starts complete at zero; a cold load
      // seeds from the snapshot (incomplete after a compacted prefix or a
      // failed lookup). The first reconciliation is the only seed.
      if (origin === "session.created") {
        st.ledger = emptyLedger(true)
      } else {
        seedScoreLedger(st, snapshot)
      }
    }
    await ensureSourceMetadata(st)
    return st
  }

  function rememberDurable(st: SessionState, durable: { seq: number } | undefined, envelopeId: string | undefined): boolean {
    if (durable !== undefined) {
      if (st.seenDurableSeqs.has(durable.seq)) {
        return false
      }
      st.seenDurableSeqs.add(durable.seq)
      if (st.seenDurableSeqs.size > MAX_SEEN_SEQS) {
        const iter = st.seenDurableSeqs.values()
        for (let i = 0; i < MAX_SEEN_SEQS / 2; i += 1) {
          const oldest = iter.next().value
          if (oldest === undefined) {
            break
          }
          st.seenDurableSeqs.delete(oldest)
        }
      }
      return true
    }
    if (envelopeId === undefined) {
      return true
    }
    if (st.seenEventIds.has(envelopeId)) {
      return false
    }
    st.seenEventIds.add(envelopeId)
    return true
  }

  async function missingStart(
    st: SessionState,
    assistantMessageID: string,
  ): Promise<GenEntry | undefined> {
    const observationId = primaryObservationId(st.sessionID, assistantMessageID)
    const existing = st.generations.get(observationId)
    if (existing) {
      return existing
    }
    let snapshot: AssistantSnapshot | undefined
    try {
      snapshot = await lookupAssistant?.(st.sessionID, assistantMessageID)
    } catch (error) {
      diagnostic(`failed assistant lookup for ${assistantMessageID}: ${String(error)}`)
    }
    if (!admitGeneration(st, observationId)) {
      return undefined
    }
    let entry: GenEntry
    if (snapshot) {
      const record: GenerationRecord = {
        observationId,
        sessionID: st.sessionID,
        kind: "primary",
        agent: snapshot.agent,
        model: snapshot.model,
        startTime: isFiniteMs(snapshot.createdAt) ? snapshot.createdAt : undefined,
        assistantMessageID,
        captureStatus: "running",
      }
      entry = { record, dirty: true, createExported: false }
      if (isFiniteMs(snapshot.streamedAt)) {
        entry.recoveredStreamedAt = snapshot.streamedAt
      }
    } else {
      // Transcript does not contain the step: keep an explicitly unavailable
      // observation; never fill model/start from another request.
      entry = {
        record: {
          observationId,
          sessionID: st.sessionID,
          kind: "primary",
          assistantMessageID,
          captureStatus: "unavailable",
        },
        dirty: true,
        createExported: false,
      }
      log(`Primary start unavailable for assistant ${assistantMessageID} in session ${st.sessionID}`)
    }
    st.generations.set(observationId, entry)
    requestExport(st)
    return entry
  }

  function handleStepStarted(st: SessionState, data: z.infer<typeof stepStartedSchema>, created: number): void {
    ledgerTurn(st, data.assistantMessageID)
    // A known child's missing agent name may be filled by its first observed
    // step agent; an established name is never overwritten (feature-013).
    if (st.parentID !== undefined && st.agent === undefined && data.agent.length > 0) {
      st.agent = boundedAgentName(data.agent)
      st.rootDirty = true
    }
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    let entry = st.generations.get(observationId)
    if (!entry) {
      if (!admitGeneration(st, observationId)) {
        return
      }
      entry = {
        record: {
          observationId,
          sessionID: st.sessionID,
          kind: "primary",
          agent: data.agent,
          model: data.model,
          startTime: isFiniteMs(data.started) ? data.started : created,
          assistantMessageID: data.assistantMessageID,
          captureStatus: "running",
        },
        dirty: true,
        createExported: false,
      }
      st.generations.set(observationId, entry)
      requestExport(st)
    }
    // Duplicate starts never create another observation or reset an existing one;
    // the model stays attached to its original request.
  }

  function handleStepStreamed(st: SessionState, data: z.infer<typeof stepKeySchema>, created: number): void {
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    const entry = st.generations.get(observationId)
    if (!entry || entry.record.captureStatus !== "running") {
      return
    }
    entry.record.endTime = created
    entry.record.endBoundary = "session.step.streamed"
    // Terminal-state update (with finish reason) is what triggers the export.
  }

  async function handleStepEnded(
    st: SessionState,
    data: z.infer<typeof stepEndedSchema>,
    created: number,
    recoveredStreamedAt: number | undefined,
  ): Promise<void> {
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    const entry = st.generations.get(observationId)
    if (!entry || entry.record.captureStatus !== "running") {
      return
    }
    entry.record.finishReason = data.finish
    entry.record.usage = {
      input: data.tokens.input,
      output: data.tokens.output,
      reasoning: data.tokens.reasoning,
      cacheRead: data.tokens.cache.read,
      cacheWrite: data.tokens.cache.write,
    }
    const hostCost = diagnosticHostCost(data.cost)
    if (hostCost !== undefined) {
      entry.record.hostCost = hostCost
    }
    entry.record.captureStatus = "completed"
    if (entry.record.endTime === undefined) {
      // No measured stream boundary: fall back to the transcript's streamed
      // time, then to the ended envelope — tagged honestly either way.
      if (isFiniteMs(recoveredStreamedAt)) {
        entry.record.endTime = recoveredStreamedAt
        entry.record.endBoundary = "assistant.time.streamed"
      } else {
        entry.record.endTime = created
        entry.record.endBoundary = "session.step.ended"
      }
    }
    entry.recoveredStreamedAt = undefined
    await attachPricing(st, entry)
  }

  async function handleStepFailed(st: SessionState, data: z.infer<typeof stepFailedSchema>, created: number): Promise<void> {
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    const entry = st.generations.get(observationId)
    if (!entry || entry.record.captureStatus !== "running") {
      return
    }
    entry.record.captureStatus = "error"
    entry.record.endTime = created
    entry.record.endBoundary = "session.step.failed"
    entry.record.statusMessage = truncate(String(data.error?.message ?? "step failed"), DIAGNOSTIC_LIMIT)
    const hostCost = diagnosticHostCost(data.cost)
    if (hostCost !== undefined) {
      entry.record.hostCost = hostCost
    }
    if (data.tokens !== undefined) {
      // Partial usage the provider reported before the failure, verbatim.
      entry.record.usage = {
        input: data.tokens.input,
        output: data.tokens.output,
        reasoning: data.tokens.reasoning,
        cacheRead: data.tokens.cache.read,
        cacheWrite: data.tokens.cache.write,
      }
    }
    await attachPricing(st, entry)
  }

  /**
   * Prices once from the entry's own model and usage; the dirty flag and
   * export request land when resolution finishes, so the per-session chain
   * (and any held export or flush drain) waits for the quote. Other sessions,
   * the event iterator, and provider-byte delivery are never delayed. A
   * quote that resolves after closing creates no records, timers, or exports.
   */
  async function attachPricing(st: SessionState, entry: GenEntry): Promise<void> {
    const { model, usage } = entry.record
    if (model === undefined || usage === undefined) {
      entry.dirty = true
      requestExport(st)
      return
    }
    const quote = await pricing.price(model, usage)
    if (closed) {
      return
    }
    if (quote !== undefined) {
      entry.record.pricing = quote
    }
    entry.dirty = true
    requestExport(st)
  }

  /** The latest native execution terminal wins, so a continued session's root covers its latest final response. */
  function markExecutionTerminal(st: SessionState, created: number): void {
    st.rootEndedAt = created
    st.executionActive = false
    // Succeeded/failed/interrupted native terminals all make scores eligible.
    st.executionTerminalSeen = true
    st.rootDirty = true
    evaluateScores(st)
  }

  /** Bounded, redacted native error/message text retained on a record. */
  function boundedNativeMessage(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0) {
      return undefined
    }
    return truncate(String(redactValue(value)), DIAGNOSTIC_LIMIT)
  }

  function gateToolInput(value: unknown): unknown {
    return value === undefined ? undefined : captureHookToolInput(value, policy)
  }

  function gateToolOutput(value: unknown): unknown {
    return value === undefined ? undefined : applyCapturePolicy({ toolOutput: value }, policy).toolOutput
  }

  function newToolEntry(sessionID: string, assistantMessageID: string, toolCallID: string, observationId: string): ToolEntry {
    return {
      record: { observationId, sessionID, assistantMessageID, toolCallID, captureStatus: "running" },
      dirty: false,
      createExported: false,
      admitted: false,
      hookSeen: false,
      terminalSeen: false,
      lookedUp: false,
      endFromHookFallback: false,
    }
  }

  async function lookupToolSnapshot(
    st: SessionState,
    assistantMessageID: string,
    toolCallID: string,
  ): Promise<ToolSnapshot | undefined> {
    try {
      return await lookupTool?.(st.sessionID, assistantMessageID, toolCallID)
    } catch (error) {
      diagnostic(`failed tool lookup for ${toolCallID}: ${String(error)}`)
      return undefined
    }
  }

  /** Merges a recovered transcript snapshot into the entry; never borrows another call's identity. */
  function applyToolSnapshot(entry: ToolEntry, snapshot: ToolSnapshot | undefined): void {
    if (!snapshot) {
      return
    }
    const record = entry.record
    if (record.name === undefined && snapshot.name.length > 0) {
      record.name = snapshot.name
    }
    if (record.startTime === undefined && isFiniteMs(snapshot.startedAt)) {
      record.startTime = snapshot.startedAt
      record.startBoundary = "transcript.tool.time"
    }
    if (record.input === undefined && snapshot.input !== undefined) {
      record.input = gateToolInput(snapshot.input)
    }
    if (record.output === undefined && snapshot.output !== undefined) {
      record.output = gateToolOutput(snapshot.output)
    }
    if (record.exitCode === undefined && snapshot.exit !== undefined) {
      record.exitCode = snapshot.exit
    }
    if (record.statusMessage === undefined && snapshot.errorMessage !== undefined) {
      record.statusMessage = snapshot.errorMessage
    }
  }

  /** Resolves a missing name/start once: name hint first, then the exact transcript tool part. */
  async function resolveToolIdentity(
    st: SessionState,
    entry: ToolEntry,
    assistantMessageID: string,
    toolCallID: string,
  ): Promise<void> {
    if (entry.lookedUp) {
      return
    }
    if (entry.record.name === undefined) {
      entry.record.name = st.toolNames.get(`${assistantMessageID}\u0000${toolCallID}`)
    }
    if (entry.record.name !== undefined && entry.record.startTime !== undefined) {
      return
    }
    entry.lookedUp = true
    const snapshot = await lookupToolSnapshot(st, assistantMessageID, toolCallID)
    applyToolSnapshot(entry, snapshot)
  }

  function settleToolOutcome(record: ToolRecord): void {
    record.captureStatus = isToolFailure(record) ? "error" : "completed"
  }

  /** A late observed child terminal extends the root endTime without rewriting root content. */
  function extendRootForChildTerminal(st: SessionState, at: number): void {
    if (st.rootEndedAt !== undefined && at > st.rootEndedAt) {
      st.observedChildTerminalMax = Math.max(st.observedChildTerminalMax ?? at, at)
      st.rootDirty = true
    }
  }

  function interruptRunningTools(st: SessionState, endBoundary: ToolEndBoundary): void {
    for (const [id, entry] of st.tools) {
      if (entry.record.captureStatus !== "running") {
        continue
      }
      if (entry.record.name === undefined) {
        // Unnameable records are never exportable; drop with the omission diagnostic.
        st.tools.delete(id)
        st.refusedTools.delete(id)
        diagnostic(
          `tool observation omitted for ${entry.record.assistantMessageID}/${entry.record.toolCallID} in session ${st.sessionID}: name unavailable`,
        )
        continue
      }
      entry.record.captureStatus = "interrupted"
      entry.record.endBoundary = endBoundary
      entry.dirty = true
    }
  }

  function interruptRunningCompactions(st: SessionState, endBoundary: CompactionEndBoundary): void {
    for (const entry of st.compactions.values()) {
      if (entry.record.captureStatus === "running") {
        entry.record.captureStatus = "interrupted"
        entry.record.endBoundary = endBoundary
        entry.closed = true
        entry.dirty = true
      }
    }
    st.activeCompaction = undefined
  }

  function newCompactionEntry(record: CompactionRecord): CompactionEntry {
    return { record, dirty: true, createExported: false, closed: false }
  }

  // ---- score ledger (feature-008): identity sets + incremental counts.

  function emptyLedger(complete: boolean): ScoreLedger {
    return { complete, turns: new Set(), tools: new Map(), toolErrorCount: 0, overflow: false }
  }

  function suppressScores(st: SessionState): void {
    if (st.ledger && !st.ledger.overflow) {
      st.ledger.overflow = true
    }
    if (!st.scoreOmissionWarned) {
      st.scoreOmissionWarned = true
      log(`Scores omitted for session "${st.sessionID}": complete history unavailable`)
    }
  }

  function ledgerFactCount(ledger: ScoreLedger): number {
    return ledger.turns.size + ledger.tools.size
  }

  /** Counts a primary turn once per assistant identity, whatever event delivered it. */
  function ledgerTurn(st: SessionState, assistantMessageID: string): void {
    const ledger = st.ledger
    if (!ledger || ledger.overflow || ledger.turns.has(assistantMessageID)) {
      return
    }
    if (ledgerFactCount(ledger) >= MAX_SCORE_FACTS_PER_SESSION) {
      suppressScores(st)
      return
    }
    ledger.turns.add(assistantMessageID)
  }

  /** Admits a tool fact once per (assistant, call) identity; outcomes start pending. */
  function ledgerToolAdmit(st: SessionState, assistantMessageID: string, toolCallID: string): void {
    const ledger = st.ledger
    if (!ledger || ledger.overflow) {
      return
    }
    const key = `${assistantMessageID}\u0000${toolCallID}`
    if (ledger.tools.has(key)) {
      return
    }
    if (ledgerFactCount(ledger) >= MAX_SCORE_FACTS_PER_SESSION) {
      suppressScores(st)
      return
    }
    ledger.tools.set(key, "pending")
  }

  /** Terminal outcome: first authoritative failure adds the error exactly once. */
  function ledgerToolOutcome(st: SessionState, assistantMessageID: string, toolCallID: string, outcome: "completed" | "error"): void {
    const ledger = st.ledger
    if (!ledger || ledger.overflow) {
      return
    }
    const key = `${assistantMessageID}\u0000${toolCallID}`
    const current = ledger.tools.get(key)
    if (current === undefined) {
      ledger.tools.set(key, outcome)
      if (outcome === "error") {
        ledger.toolErrorCount += 1
      }
      return
    }
    if (current === outcome) {
      return
    }
    if (outcome === "error") {
      ledger.tools.set(key, "error")
      ledger.toolErrorCount += 1
    } else if (current === "pending") {
      ledger.tools.set(key, "completed")
    }
    // completed-after-error keeps the authoritative failure already counted.
  }

  /** Observation-settled outcome sync: the record classification is the single source of truth. */
  function syncLedgerToolOutcome(st: SessionState, record: ToolRecord): void {
    if (record.captureStatus === "error") {
      ledgerToolOutcome(st, record.assistantMessageID, record.toolCallID, "error")
    } else if (record.captureStatus === "completed") {
      ledgerToolOutcome(st, record.assistantMessageID, record.toolCallID, "completed")
    }
    // running/interrupted observations leave the fact pending: no fabricated success.
  }

  /** First-reconciliation seeding; a warm ledger is never replaced by a later read. */
  function seedScoreLedger(st: SessionState, snapshot: SessionSnapshot | undefined): void {
    const history = snapshot?.scoreHistory
    if (!history || !history.complete) {
      st.ledger = emptyLedger(false)
      return
    }
    const ledger = emptyLedger(true)
    for (const turn of history.turns) {
      ledger.turns.add(turn)
    }
    for (const tool of history.tools) {
      const key = `${tool.assistantMessageID}\u0000${tool.toolCallID}`
      if (ledger.tools.has(key)) {
        continue
      }
      // ADR-0004 classification applies to seeds too: a completed native
      // shell part with a finite non-zero exit is a failure, never a success.
      const shellExitFailure = tool.name === "shell" && typeof tool.exit === "number" && Number.isFinite(tool.exit) && tool.exit !== 0
      const outcome: ToolScoreOutcome =
        tool.status === "error" || shellExitFailure ? "error" : tool.status === "completed" ? "completed" : "pending"
      ledger.tools.set(key, outcome)
      if (outcome === "error") {
        ledger.toolErrorCount += 1
      }
    }
    if (ledgerFactCount(ledger) > MAX_SCORE_FACTS_PER_SESSION) {
      ledger.overflow = true
    }
    st.ledger = ledger
  }

  /**
   * Publication readiness: complete history, no overflow, an observed native
   * execution terminal, and no pending tool facts. Ready revisions turn dirty
   * only when the counts changed; incomplete sessions omit all five updates
   * with one bounded warning.
   */
  function evaluateScores(st: SessionState): void {
    const ledger = st.ledger
    if (!ledger || ledger.overflow || !ledger.complete) {
      if (st.executionTerminalSeen) {
        suppressScores(st)
      }
      return
    }
    if (!st.executionTerminalSeen) {
      return
    }
    for (const outcome of ledger.tools.values()) {
      if (outcome === "pending") {
        return
      }
    }
    const counts: ScoreCounts = {
      toolCallCount: ledger.tools.size,
      turnCount: ledger.turns.size,
      toolErrorCount: ledger.toolErrorCount,
    }
    const published = st.publishedScores
    if (
      !published ||
      published.toolCallCount !== counts.toolCallCount ||
      published.turnCount !== counts.turnCount ||
      published.toolErrorCount !== counts.toolErrorCount
    ) {
      st.scoresDirty = true
      requestExport(st)
    }
  }

  function scoreRevisionOf(st: SessionState): ScoreCounts | undefined {
    const ledger = st.ledger
    if (!ledger || ledger.overflow || !ledger.complete) {
      return undefined
    }
    return {
      toolCallCount: ledger.tools.size,
      turnCount: ledger.turns.size,
      toolErrorCount: ledger.toolErrorCount,
    }
  }

  function handleCompactionStarted(
    st: SessionState,
    data: z.infer<typeof compactionStartedSchema>,
    created: number,
    seq: number,
  ): void {
    // A new start while an older lifecycle is still open: the older one is
    // interrupted (never completed) with an honest boundary.
    const active = st.activeCompaction
    if (active) {
      const previous = st.compactions.get(active.observationId)
      if (previous && !previous.closed) {
        previous.record.captureStatus = "interrupted"
        previous.record.endBoundary = "next-compaction.started"
        previous.record.endTime = created
        previous.closed = true
        previous.dirty = true
        requestExport(st)
      }
      st.activeCompaction = undefined
    }
    const observationId = compactionStartId(st.sessionID, seq)
    if (!st.compactions.has(observationId)) {
      if (!admitCompaction(st, observationId)) {
        // Refused telemetry keeps the active pointer consistent for later terminals.
        st.activeCompaction = { observationId, startedSeq: seq, reason: data.reason }
        return
      }
      const record: CompactionRecord = {
        observationId,
        sessionID: st.sessionID,
        reason: data.reason,
        startTime: created,
        captureStatus: "running",
        startBoundary: "session.compaction.started",
      }
      if (data.inputID !== undefined) {
        record.inputID = data.inputID
      }
      st.compactions.set(observationId, newCompactionEntry(record))
      requestExport(st)
    }
    st.activeCompaction = { observationId, startedSeq: seq, reason: data.reason }
  }

  function handleCompactionEnded(
    st: SessionState,
    data: z.infer<typeof compactionEndedSchema>,
    created: number,
    seq: number,
  ): void {
    const active = st.activeCompaction
    if (active && active.reason === data.reason) {
      const entry = st.compactions.get(active.observationId)
      if (entry && !entry.closed) {
        // The durable ended fact's `created` is the authoritative end time.
        entry.record.endTime = created
        entry.record.endBoundary = "session.compaction.ended"
        entry.record.captureStatus = "completed"
        entry.closed = true
        entry.dirty = true
        requestExport(st)
        extendRootForChildTerminal(st, created)
      }
      st.activeCompaction = undefined
      return
    }
    // No matching active start: terminal-only span, never a guessed start.
    if (!admitCompaction(st, compactionTerminalId(st.sessionID, seq))) {
      return
    }
    const record: CompactionRecord = {
      observationId: compactionTerminalId(st.sessionID, seq),
      sessionID: st.sessionID,
      reason: data.reason,
      endTime: created,
      captureStatus: "completed",
      startBoundary: "unavailable",
      endBoundary: "session.compaction.ended",
    }
    st.compactions.set(record.observationId, newCompactionEntry(record))
    diagnostic(`compaction ended without a matching active start in session ${st.sessionID}; exported terminal-only span`)
    requestExport(st)
    extendRootForChildTerminal(st, created)
  }

  function handleCompactionFailed(
    st: SessionState,
    data: z.infer<typeof compactionFailedSchema>,
    created: number,
    seq: number,
  ): void {
    const interrupted = data.error.type === "compaction.interrupted"
    const terminalStatus = interrupted ? ("interrupted" as const) : ("error" as const)
    const active = st.activeCompaction
    if (active && active.reason === data.reason) {
      const entry = st.compactions.get(active.observationId)
      if (entry && !entry.closed) {
        entry.record.endTime = created
        entry.record.endBoundary = "session.compaction.failed"
        entry.record.captureStatus = terminalStatus
        // inputID consistency: both facts present and disagreeing keeps the start's value.
        if (data.inputID !== undefined && entry.record.inputID !== undefined && entry.record.inputID !== data.inputID) {
          diagnostic(
            `compaction failed inputID ${data.inputID} differs from started ${entry.record.inputID} in session ${st.sessionID}; keeping the started value`,
          )
        } else if (entry.record.inputID === undefined && data.inputID !== undefined) {
          entry.record.inputID = data.inputID
        }
        entry.closed = true
        entry.dirty = true
        requestExport(st)
        extendRootForChildTerminal(st, created)
      }
      st.activeCompaction = undefined
      return
    }
    if (!admitCompaction(st, compactionTerminalId(st.sessionID, seq))) {
      return
    }
    const record: CompactionRecord = {
      observationId: compactionTerminalId(st.sessionID, seq),
      sessionID: st.sessionID,
      reason: data.reason,
      endTime: created,
      captureStatus: terminalStatus,
      startBoundary: "unavailable",
      endBoundary: "session.compaction.failed",
    }
    if (data.inputID !== undefined) {
      record.inputID = data.inputID
    }
    st.compactions.set(record.observationId, newCompactionEntry(record))
    diagnostic(`compaction failed without a matching active start in session ${st.sessionID}; exported terminal-only span`)
    requestExport(st)
    extendRootForChildTerminal(st, created)
  }

  async function handleToolCalled(
    st: SessionState,
    data: z.infer<typeof toolCalledSchema>,
    created: number,
  ): Promise<void> {
    const observationId = toolObservationId(st.sessionID, data.assistantMessageID, data.id)
    let entry = st.tools.get(observationId)
    if (!entry) {
      if (!admitTool(st, observationId)) {
        return
      }
      entry = newToolEntry(st.sessionID, data.assistantMessageID, data.id, observationId)
      st.tools.set(observationId, entry)
      ledgerToolAdmit(st, data.assistantMessageID, data.id)
    }
    if (!entry.admitted) {
      // `called` admits the executed call and supplies the start time.
      entry.admitted = true
      entry.record.startTime = created
      entry.record.startBoundary = "session.tool.called"
    }
    // The hook's final input wins; a late duplicate called event never downgrades it.
    if (!entry.hookSeen) {
      const gated = gateToolInput(data.input)
      if (gated !== undefined) {
        entry.record.input = gated
      }
    }
    await resolveToolIdentity(st, entry, data.assistantMessageID, data.id)
    entry.dirty = true
    requestExport(st)
  }

  async function handleToolTerminal(
    st: SessionState,
    kind: "success" | "failed",
    data: z.infer<typeof toolSuccessSchema> | z.infer<typeof toolFailedSchema>,
    created: number,
  ): Promise<void> {
    const observationId = toolObservationId(st.sessionID, data.assistantMessageID, data.id)
    let entry = st.tools.get(observationId)
    if (!entry) {
      if (!admitTool(st, observationId)) {
        return
      }
      // Terminal without called: one admitted call, no fabricated start time.
      entry = newToolEntry(st.sessionID, data.assistantMessageID, data.id, observationId)
      entry.admitted = true
      entry.record.startBoundary = "unavailable"
      st.tools.set(observationId, entry)
    }
    // The scalar score fact keeps its terminal outcome even when the span is
    // omitted below — the durable fact is authoritative either way.
    ledgerToolAdmit(st, data.assistantMessageID, data.id)
    ledgerToolOutcome(st, data.assistantMessageID, data.id, kind === "success" ? "completed" : "error")
    evaluateScores(st)
    await resolveToolIdentity(st, entry, data.assistantMessageID, data.id)
    if (entry.record.name === undefined) {
      // Unnameable: omit the span with one bounded diagnostic; scalar score facts are kept above.
      st.tools.delete(observationId)
      st.refusedTools.delete(observationId)
      diagnostic(
        `tool observation omitted for ${data.assistantMessageID}/${data.id} in session ${st.sessionID}: name unavailable`,
      )
      return
    }
    const record = entry.record
    const exit = nativeExit(data.metadata?.exit)
    if (kind === "success") {
      if ("content" in data && record.output === undefined) {
        record.output = gateToolOutput(toolOutputText(data.content))
      }
      if (record.nativeStatus === undefined) {
        record.nativeStatus = "completed"
        record.outcomeSource = "session.tool.success"
      }
    } else {
      if ("error" in data && record.statusMessage === undefined) {
        record.statusMessage = boundedNativeMessage(data.error.message)
      }
      if (record.nativeStatus === undefined) {
        record.nativeStatus = "error"
        record.outcomeSource = "session.tool.failed"
      }
    }
    if (exit !== undefined && record.exitCode === undefined) {
      record.exitCode = exit
    }
    // The durable terminal's `created` is the preferred endTime over the hook fallback.
    if (!entry.terminalSeen || entry.endFromHookFallback) {
      record.endTime = created
      record.endBoundary = kind === "success" ? "session.tool.success" : "session.tool.failed"
      entry.endFromHookFallback = false
    }
    entry.terminalSeen = true
    settleToolOutcome(record)
    syncLedgerToolOutcome(st, record)
    evaluateScores(st)
    entry.dirty = true
    requestExport(st)
    extendRootForChildTerminal(st, created)
  }

  /** State-task merge of one hook receipt; values were captured synchronously at hook time. */
  function mergeToolHook(
    st: SessionState,
    facts: {
      assistantMessageID: string
      toolCallID: string
      name: string
      status: "completed" | "error"
      input: unknown
      output: unknown
      exit: number | undefined
      errorMessage: string | undefined
      fallbackEnd: number
    },
  ): void {
    const observationId = toolObservationId(st.sessionID, facts.assistantMessageID, facts.toolCallID)
    let entry = st.tools.get(observationId)
    if (!entry) {
      if (!admitTool(st, observationId)) {
        return
      }
      entry = newToolEntry(st.sessionID, facts.assistantMessageID, facts.toolCallID, observationId)
      entry.admitted = true
      // Hook receipt without a called fact: admitted, no fabricated start time.
      entry.record.startBoundary = "unavailable"
      st.tools.set(observationId, entry)
      ledgerToolAdmit(st, facts.assistantMessageID, facts.toolCallID)
    }
    entry.hookSeen = true
    const record = entry.record
    if (record.name === undefined) {
      record.name = facts.name
    }
    // The hook's final input replaces any earlier captured value (detached at receipt).
    if (facts.input !== undefined) {
      record.input = facts.input
    }
    // Enrichment only — a late hook never downgrades already-captured output or messages.
    if (record.output === undefined && facts.output !== undefined) {
      record.output = facts.output
    }
    if (record.statusMessage === undefined && facts.errorMessage !== undefined) {
      record.statusMessage = facts.errorMessage
    }
    if (record.exitCode === undefined && facts.exit !== undefined) {
      record.exitCode = facts.exit
    }
    // The actual hook status is authoritative; relabel the outcome source when it changes the outcome.
    const previousNative = record.nativeStatus
    record.nativeStatus = facts.status
    if (previousNative === undefined || previousNative !== facts.status) {
      record.outcomeSource = "execute.after"
    }
    if (!entry.terminalSeen) {
      // Tagged fallback end boundary; a matching durable terminal's `created` replaces it.
      record.endTime = facts.fallbackEnd
      record.endBoundary = "execute.after"
      entry.endFromHookFallback = true
    }
    entry.terminalSeen = true
    settleToolOutcome(record)
    syncLedgerToolOutcome(st, record)
    evaluateScores(st)
    entry.dirty = true
    requestExport(st)
    extendRootForChildTerminal(st, facts.fallbackEnd)
  }

  function envelopeSessionID(type: string, data: unknown): string | undefined {
    if (!isRecord(data)) {
      return undefined
    }
    const sessionID = data.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
  }

  async function exportNow(sessionID: string, signal?: AbortSignal): Promise<void> {
    const st = states.get(sessionID)
    if (!st) {
      return
    }
    st.exporting = true
    try {
      // The grace deadline for this batch is consumed here; changes arriving
      // during the POST get their own fresh deadline.
      st.exportDeadline = undefined
      if (st.exportTimer !== undefined) {
        clearTimeout(st.exportTimer)
        st.exportTimer = undefined
      }
      const emittedAt = now()
      const events: IngestEvent[] = []

      const rootNeedsExport = !st.rootExported || st.rootDirty
      if (rootNeedsExport) {
        // Child traces link to their direct parent (feature-013); source
        // metadata (feature-011) rides trace metadata only; the root
        // observation keeps its own metadata without source fields, and child
        // observations are never touched.
        const childLabel = st.parentID !== undefined ? subagentLabel(st.agent) : undefined
        const traceName = childLabel !== undefined ? `${SUBAGENT_TRACE_NAME_PREFIX}${childLabel}` : TRACE_NAME
        const linkMetadata: Record<string, string> =
          st.parentID !== undefined
            ? {
                role: "subagent",
                parentSessionID: st.parentID,
                parent_trace_id: sessionIdentity(st.parentID).traceId,
                ...(st.agent !== undefined ? { agent: st.agent } : {}),
              }
            : {}
        const traceCaptured = applyCapturePolicy(
          {
            input: st.firstPrompt,
            output: st.latestAssistantOutput,
            metadata: { ...linkMetadata, ...st.sourceMetadata, sessionId: st.sessionID, completed: st.rootEndedAt !== undefined },
          },
          policy,
        )
        const captured = applyCapturePolicy(
          {
            input: st.firstPrompt,
            output: st.latestAssistantOutput,
            metadata: { ...linkMetadata, sessionId: st.sessionID, completed: st.rootEndedAt !== undefined },
          },
          policy,
        )
        const startIso = toIso(st.createdAt)
        const endMs =
          st.rootEndedAt !== undefined
            ? Math.max(st.rootEndedAt, st.observedChildTerminalMax ?? st.rootEndedAt)
            : undefined
        const endIso = toIso(endMs)
        // Children group under the direct parent's Langfuse session id while
        // keeping their own trace/root identities (feature-013).
        const langfuseSessionId = truncate(st.parentID ?? st.sessionID, LANGFUSE_SESSION_ID_MAX)

        const traceBody: Record<string, unknown> = {
          id: st.identity.traceId,
          name: traceName,
          sessionId: langfuseSessionId,
          metadata: traceCaptured.metadata,
        }
        if (startIso !== undefined) {
          traceBody.timestamp = startIso
        }
        if (traceCaptured.input !== undefined) {
          traceBody.input = traceCaptured.input
        }
        if (traceCaptured.output !== undefined) {
          traceBody.output = traceCaptured.output
        }
        events.push({ id: newId(), type: "trace-create", timestamp: new Date(emittedAt).toISOString(), body: traceBody })

        const spanBody: Record<string, unknown> = {
          id: st.identity.rootObservationId,
          traceId: st.identity.traceId,
          name: traceName,
          level: "DEFAULT",
          metadata: captured.metadata,
        }
        if (startIso !== undefined) {
          spanBody.startTime = startIso
        }
        if (endIso !== undefined) {
          spanBody.endTime = endIso
        }
        if (captured.input !== undefined) {
          spanBody.input = captured.input
        }
        if (captured.output !== undefined) {
          spanBody.output = captured.output
        }
        // The root stays open (no manufactured endTime) until a real terminal exists.
        events.push({
          id: newId(),
          type: st.rootExported ? "span-update" : "span-create",
          timestamp: new Date(emittedAt).toISOString(),
          body: spanBody,
        })
      }

      for (const entry of st.generations.values()) {
        if (!entry.dirty) {
          continue
        }
        const phase = entry.createExported ? "update" : "create"
        events.push(
          buildGenerationEvent(entry.record, st.identity, phase, newId(), emittedAt, policy),
        )
      }

      // Unnameable records are never exported; they wait (or get dropped at
      // terminal/shutdown with a diagnostic).
      for (const entry of st.tools.values()) {
        if (!entry.dirty || entry.record.name === undefined) {
          continue
        }
        const phase = entry.createExported ? "update" : "create"
        events.push(buildToolEvent(entry.record, st.identity, phase, newId(), emittedAt, policy))
      }

      for (const entry of st.compactions.values()) {
        if (!entry.dirty) {
          continue
        }
        const phase = entry.createExported ? "update" : "create"
        events.push(buildCompactionEvent(entry.record, st.identity, phase, newId(), emittedAt, policy))
      }

      // Cumulative scores publish only for a ready revision; the submitted
      // revision is snapshotted below, before the POST.
      let scoreRevision: ScoreCounts | undefined
      if (st.scoresDirty) {
        const revision = scoreRevisionOf(st)
        if (revision) {
          scoreRevision = revision
          const scores = computeScores(revision)
          for (const name of SCORE_NAMES as readonly ScoreName[]) {
            events.push(buildScoreEvent(name, scores[name], st.identity.traceId, scoreId(st.sessionID, name), newId(), emittedAt))
          }
        }
      }

      if (events.length === 0) {
        return
      }

      // Detach the submitted snapshot from dirty state before posting; changes
      // arriving during the POST stay dirty for the next ordered batch.
      if (rootNeedsExport) {
        st.rootExported = true
        st.rootDirty = false
      }
      for (const entry of st.generations.values()) {
        if (entry.dirty) {
          entry.dirty = false
          entry.createExported = true
        }
      }
      for (const entry of st.tools.values()) {
        if (entry.dirty && entry.record.name !== undefined) {
          entry.dirty = false
          entry.createExported = true
        }
      }
      for (const entry of st.compactions.values()) {
        if (entry.dirty) {
          entry.dirty = false
          entry.createExported = true
        }
      }
      // Only the actually submitted score revision is published/cleared;
      // changes during the held POST stay dirty for the next batch.
      if (scoreRevision) {
        st.scoresDirty = false
        st.publishedScores = scoreRevision
      }

      const result = await transport.ingest(events, signal ? { signal } : undefined)
      if (result.failed > 0) {
        const text = `Failed to persist ${result.failed}/${events.length} event(s) for session ${sessionID}`
        log(text)
        try {
          onError?.(text)
        } catch {
          // Observer failures never alter export bookkeeping.
        }
      }
      resetCapacityEpisode(st)
      pruneSettledGenerations(st)
      pruneSettledTools(st)
      pruneSettledCompactions(st)
      if (pendingGenerationCount(st) > 0 || pendingToolCount(st) > 0 || pendingCompactionCount(st) > 0 || st.rootDirty || st.scoresDirty) {
        requestExport(st)
      }
    } finally {
      st.exporting = false
    }
  }

  function auxStartTask(descriptor: AuxDescriptor): Promise<void> {
    return enqueueState(descriptor.sessionID, async () => {
      const st = await reconcile(descriptor.sessionID, descriptor.dispatchAt, true)
      if (!st || descriptor.admitted) {
        return
      }
      if (st.parentID !== undefined && st.agent === undefined && descriptor.agent !== undefined) {
        st.agent = boundedAgentName(descriptor.agent)
        st.rootDirty = true
      }
      if (!admitGeneration(st, descriptor.observationId)) {
        return
      }
      const record: GenerationRecord = {
        observationId: descriptor.observationId,
        sessionID: st.sessionID,
        kind: descriptor.kind,
        agent: descriptor.agent,
        model: descriptor.model,
        startTime: descriptor.dispatchAt,
        httpStatus: descriptor.httpStatus,
        captureStatus: descriptor.terminal ? terminalCaptureStatus(descriptor) : "running",
      }
      if (descriptor.terminal) {
        applyAuxTerminal(record, descriptor)
      }
      st.generations.set(descriptor.observationId, { record, dirty: true, createExported: false })
      descriptor.admitted = true
      requestExport(st)
    })
  }

  function terminalCaptureStatus(descriptor: AuxDescriptor): GenerationRecord["captureStatus"] {
    const status = descriptor.httpStatus !== undefined && descriptor.httpStatus >= 400 ? "error" : descriptor.terminal?.status ?? "running"
    return status as GenerationRecord["captureStatus"]
  }

  function applyAuxTerminal(record: GenerationRecord, descriptor: AuxDescriptor): void {
    const terminal = descriptor.terminal
    if (!terminal) {
      return
    }
    record.endTime = terminal.at
    if (descriptor.httpStatus !== undefined && descriptor.httpStatus >= 400) {
      record.captureStatus = "error"
      record.statusMessage = `provider returned HTTP ${descriptor.httpStatus}`
      return
    }
    switch (terminal.status) {
      case "completed":
        record.captureStatus = "completed"
        break
      case "error":
        record.captureStatus = "error"
        record.statusMessage = truncate(String(terminal.message ?? "response body failed"), DIAGNOSTIC_LIMIT)
        break
      case "cancelled":
        record.captureStatus = "cancelled"
        break
      case "unavailable":
        record.captureStatus = "unavailable"
        break
    }
  }

  function onAuxTerminal(descriptor: AuxDescriptor, completion: AuxiliaryCompletion): void {
    if (closed) {
      return
    }
    descriptor.terminal = completion
    liveAux.delete(descriptor)
    void enqueueState(descriptor.sessionID, async () => {
      if (closed) {
        return
      }
      const st = await reconcile(descriptor.sessionID, completion.at, false)
      const entry = st?.generations.get(descriptor.observationId)
      if (!st || !entry) {
        return
      }
      if (entry.record.captureStatus !== "running") {
        return
      }
      applyAuxTerminal(entry.record, descriptor)
      if (st && st.rootEndedAt !== undefined && completion.at > st.rootEndedAt) {
        st.observedChildTerminalMax = Math.max(st.observedChildTerminalMax ?? completion.at, completion.at)
        st.rootDirty = true
      }
      entry.dirty = true
      requestExport(st)
    }).catch((error) => diagnostic(`auxiliary terminal update failed: ${String(error)}`))
  }

  function validateAuxInfo(info: AuxiliaryRequestInfo | AuxiliaryResponseInfo): boolean {
    return (
      typeof info.sessionID === "string" &&
      info.sessionID.length > 0 &&
      typeof info.model?.id === "string" &&
      info.model.id.length > 0 &&
      typeof info.model.providerID === "string" &&
      info.model.providerID.length > 0 &&
      (info.agent === undefined || typeof info.agent === "string") &&
      (info.kind === "title" || info.kind === "compaction" || info.kind === "generate")
    )
  }

  return {
    handleEvent(event: unknown): Promise<void> {
      if (closed) {
        return Promise.resolve()
      }
      const envelope = envelopeSchema.safeParse(event)
      if (!envelope.success) {
        return Promise.resolve()
      }
      const { type, created, durable, id: envelopeId } = envelope.data
      if (!(type in SELECTED_EVENT_TYPES)) {
        return Promise.resolve()
      }
      const sessionID = envelopeSessionID(type, envelope.data.data)
      if (sessionID === undefined) {
        diagnostic(`event ${type} has no usable sessionID; dropped`)
        return Promise.resolve()
      }
      // Native birth facts (directory, parentID, agent) are read once at
      // dispatch; child sessions are admitted like primaries (feature-013).
      let birth: Pick<SessionSnapshot, "directory" | "parentID" | "agent"> | undefined
      if (type === "session.created" && isRecord(envelope.data.data)) {
        const dir = birthDirectory(envelope.data.data)
        const rawParent = envelope.data.data.parentID
        const parentID = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : undefined
        const rawAgent = envelope.data.data.agent
        const agent = typeof rawAgent === "string" && rawAgent.length > 0 ? rawAgent : undefined
        birth = {
          ...(dir !== undefined ? { directory: dir } : {}),
          ...(parentID !== undefined ? { parentID } : {}),
          ...(agent !== undefined ? { agent } : {}),
        }
      }
      return enqueueState(sessionID, async () => {
        // The event was accepted before this task ran, so its session may still
        // be created even when shutdown began in the meantime.
        const st = await reconcile(
          sessionID,
          created,
          true,
          type === "session.created" ? "session.created" : undefined,
          birth,
        )
        if (!st || !rememberDurable(st, durable, envelopeId)) {
          return
        }
        switch (type) {
          case "session.created": {
            // Admitted above (no parentID); facts already recorded.
            st.rootDirty = st.rootDirty || !st.rootExported
            break
          }
          case "session.inbox.enqueued": {
            const parsed = inboxEnqueuedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.inbox.enqueued for ${sessionID}`)
              return
            }
            if (parsed.data.item?.type !== "user") {
              return
            }
            const text = parsed.data.item.payload?.text
            if (text === undefined) {
              return
            }
            if (st.firstPrompt === undefined) {
              st.firstPrompt = text
              st.rootDirty = true
            }
            break
          }
          case "session.text.ended": {
            const parsed = textEndedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.text.ended for ${sessionID}`)
              return
            }
            // Auxiliary titles/summaries/generate flows never emit this event,
            // so it is inherently the primary assistant output.
            st.latestAssistantOutput = parsed.data.text
            st.rootDirty = true
            break
          }
          case "session.execution.started": {
            const parsed = executionStartedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.execution.started for ${sessionID}`)
              return
            }
            // Distinct score execution-active boundary; the terminal events publish.
            st.executionActive = true
            break
          }
          case "session.execution.succeeded": {
            markExecutionTerminal(st, created)
            requestExport(st)
            break
          }
          case "session.execution.failed": {
            const parsed = executionFailedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.execution.failed for ${sessionID}`)
              return
            }
            markExecutionTerminal(st, created)
            requestExport(st)
            break
          }
          case "session.execution.interrupted": {
            const parsed = executionInterruptedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.execution.interrupted for ${sessionID}`)
              return
            }
            markExecutionTerminal(st, created)
            for (const entry of st.generations.values()) {
              if (entry.record.kind === "primary" && entry.record.captureStatus === "running") {
                entry.record.captureStatus = "interrupted"
                entry.record.statusMessage = `execution interrupted (${parsed.data.reason ?? "unknown reason"})`
                entry.dirty = true
              }
            }
            interruptRunningTools(st, "session.execution.interrupted")
            interruptRunningCompactions(st, "session.execution.interrupted")
            requestExport(st)
            break
          }
          case "session.step.started": {
            const parsed = stepStartedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.step.started for ${sessionID}`)
              return
            }
            handleStepStarted(st, parsed.data, created)
            break
          }
          case "session.step.streamed": {
            const parsed = stepKeySchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.step.streamed for ${sessionID}`)
              return
            }
            ledgerTurn(st, parsed.data.assistantMessageID)
            const observationId = primaryObservationId(sessionID, parsed.data.assistantMessageID)
            if (!st.generations.has(observationId)) {
              const recovered = await missingStart(st, parsed.data.assistantMessageID)
              if (recovered) {
                handleStepStreamed(st, parsed.data, created)
              }
              return
            }
            handleStepStreamed(st, parsed.data, created)
            break
          }
          case "session.step.ended": {
            const parsed = stepEndedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.step.ended for ${sessionID}`)
              return
            }
            ledgerTurn(st, parsed.data.assistantMessageID)
            const observationId = primaryObservationId(sessionID, parsed.data.assistantMessageID)
            let recoveredStreamedAt: number | undefined
            if (!st.generations.has(observationId)) {
              const recovered = await missingStart(st, parsed.data.assistantMessageID)
              if (!recovered) {
                return
              }
              recoveredStreamedAt = recovered.recoveredStreamedAt
            }
            await handleStepEnded(st, parsed.data, created, recoveredStreamedAt)
            break
          }
          case "session.step.failed": {
            const parsed = stepFailedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.step.failed for ${sessionID}`)
              return
            }
            // Provider failures still count their primary turn.
            ledgerTurn(st, parsed.data.assistantMessageID)
            const observationId = primaryObservationId(sessionID, parsed.data.assistantMessageID)
            if (!st.generations.has(observationId)) {
              const recovered = await missingStart(st, parsed.data.assistantMessageID)
              if (!recovered) {
                return
              }
            }
            await handleStepFailed(st, parsed.data, created)
            break
          }
          case "session.tool.input.started": {
            const parsed = toolInputStartedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.tool.input.started for ${sessionID}`)
              return
            }
            // Name hint only: input.started never creates or counts an executed call.
            const key = `${parsed.data.assistantMessageID}\u0000${parsed.data.id}`
            if (!st.toolNames.has(key)) {
              st.toolNames.set(key, parsed.data.name)
              if (st.toolNames.size > MAX_PENDING_TOOLS_PER_SESSION) {
                const oldest = st.toolNames.keys().next().value
                if (oldest !== undefined) {
                  st.toolNames.delete(oldest)
                }
              }
            }
            break
          }
          case "session.tool.called": {
            const parsed = toolCalledSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.tool.called for ${sessionID}`)
              return
            }
            await handleToolCalled(st, parsed.data, created)
            break
          }
          case "session.tool.success": {
            const parsed = toolSuccessSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.tool.success for ${sessionID}`)
              return
            }
            await handleToolTerminal(st, "success", parsed.data, created)
            break
          }
          case "session.tool.failed": {
            const parsed = toolFailedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.tool.failed for ${sessionID}`)
              return
            }
            await handleToolTerminal(st, "failed", parsed.data, created)
            break
          }
          case "session.compaction.started": {
            const parsed = compactionStartedSchema.safeParse(envelope.data.data)
            const seq = durable?.seq
            if (!parsed.success || typeof seq !== "number") {
              // Fail open: a malformed lifecycle fact never blocks other telemetry.
              diagnostic(`malformed session.compaction.started for ${sessionID}`)
              return
            }
            handleCompactionStarted(st, parsed.data, created, seq)
            break
          }
          case "session.compaction.ended": {
            const parsed = compactionEndedSchema.safeParse(envelope.data.data)
            const seq = durable?.seq
            if (!parsed.success || typeof seq !== "number") {
              diagnostic(`malformed session.compaction.ended for ${sessionID}`)
              return
            }
            handleCompactionEnded(st, parsed.data, created, seq)
            break
          }
          case "session.compaction.failed": {
            const parsed = compactionFailedSchema.safeParse(envelope.data.data)
            const seq = durable?.seq
            if (!parsed.success || typeof seq !== "number") {
              diagnostic(`malformed session.compaction.failed for ${sessionID}`)
              return
            }
            handleCompactionFailed(st, parsed.data, created, seq)
            break
          }
        }
      })
    },

    startAuxiliary(info: AuxiliaryRequestInfo): void {
      if (closed || !validateAuxInfo(info)) {
        return
      }
      const descriptor: AuxDescriptor = {
        observationId: newId(),
        sessionID: info.sessionID,
        kind: info.kind,
        agent: info.agent,
        model: { id: info.model.id, providerID: info.model.providerID, variant: info.model.variant },
        dispatchAt: now(),
        admitted: false,
      }
      // Synchronously allocated before any async lookup is enqueued.
      auxByRequest.set(info.request, descriptor)
      liveAux.add(descriptor)
      void auxStartTask(descriptor).catch((error) => diagnostic(`auxiliary start failed: ${String(error)}`))
    },

    observeAuxiliaryResponse(info: AuxiliaryResponseInfo): Response {
      if (closed) {
        return info.response
      }
      const descriptor = auxByRequest.get(info.request)
      if (!descriptor) {
        diagnostic(`unmatched auxiliary response for session ${info.sessionID} (${info.kind}); returned unchanged`)
        return info.response
      }
      descriptor.httpStatus = info.response.status
      const entry = states.get(descriptor.sessionID)?.generations.get(descriptor.observationId)
      if (entry) {
        entry.record.httpStatus = descriptor.httpStatus
      }
      const observed = observeAuxiliaryResponse(info.response, (completion) => onAuxTerminal(descriptor, completion), now)
      if (observed.response !== info.response) {
        descriptor.observed = observed
      }
      return observed.response
    },

    handleToolAfter(event: unknown): void {
      if (closed) {
        return
      }
      const parsed = toolAfterSchema.safeParse(event)
      if (!parsed.success) {
        diagnostic("malformed tool execute.after payload; dropped")
        return
      }
      const data = parsed.data
      // Capture once, synchronously, into detached policy-gated values before
      // enqueueing: the native tool pipeline is never awaited or mutated, and
      // nothing here can block provider delivery.
      const input = captureHookToolInput(data.input, policy)
      const output = data.status === "completed" ? captureHookToolOutput(data.result, policy) : undefined
      const exit =
        data.status === "completed" && isRecord(data.result) && isRecord(data.result.metadata)
          ? nativeExit(data.result.metadata.exit)
          : undefined
      const errorMessage = data.status === "error" ? boundedNativeMessage(data.error?.message) : undefined
      const fallbackEnd = now()
      void enqueueState(data.sessionID, async () => {
        const st = await reconcile(data.sessionID, fallbackEnd, true)
        if (!st) {
          return
        }
        mergeToolHook(st, {
          assistantMessageID: data.messageID,
          toolCallID: data.id,
          name: data.tool,
          status: data.status,
          input,
          output,
          exit,
          errorMessage,
          fallbackEnd,
        })
      }).catch((error) => diagnostic(`tool after-hook update failed: ${String(error)}`))
    },

    async flushNow(sessionID: string): Promise<void> {
      if (closed) {
        return
      }
      const stateTail = stateChains.get(sessionID)
      if (stateTail) {
        await stateTail.catch(noop)
      }
      await runExportChain(sessionID).catch(noop)
    },

    async flushAll(): Promise<void> {
      if (closed) {
        return
      }
      // Sessions with queued-but-unstarted state work may not have records yet.
      const ids = new Set<string>([...states.keys(), ...stateChains.keys()])
      const tails = [...ids].map(async (sessionID) => {
        const stateTail = stateChains.get(sessionID)
        if (stateTail) {
          await stateTail.catch(noop)
        }
        if (states.has(sessionID)) {
          await runExportChain(sessionID).catch(noop)
        }
      })
      await Promise.all(tails)
    },

    pendingSessionIds(): string[] {
      const ids: string[] = []
      for (const st of states.values()) {
        if (
          st.rootDirty ||
          st.scoresDirty ||
          st.exporting ||
          (pendingWorkBySession.get(st.sessionID) ?? 0) > 0 ||
          pendingGenerationCount(st) > 0 ||
          pendingToolCount(st) > 0 ||
          pendingCompactionCount(st) > 0
        ) {
          ids.push(st.sessionID)
        }
      }
      return ids
    },

    shutdown(): Promise<void> {
      if (shutdownPromise) {
        return shutdownPromise
      }
      shutdownPromise = (async () => {
        closed = true
        const controller = new AbortController()
        let aborted = false
        let deadlineHandle: ReturnType<typeof setTimeout> | undefined
        // Ordinary mockable setTimeout owns the overall deadline.
        const deadlinePromise = new Promise<void>((resolve) => {
          deadlineHandle = setTimeout(() => {
            aborted = true
            controller.abort()
            resolve()
          }, shutdownTimeoutMs)
        })
        try {
          // Detach observers: telemetry callbacks stop; provider bodies untouched.
          for (const descriptor of liveAux) {
            descriptor.observed?.detach()
          }
          // Cancel flush timers and mark unfinished observations interrupted.
          for (const st of states.values()) {
            if (st.exportTimer !== undefined) {
              clearTimeout(st.exportTimer)
              st.exportTimer = undefined
            }
            for (const entry of st.generations.values()) {
              if (entry.record.captureStatus === "running") {
                entry.record.captureStatus = "interrupted"
                entry.record.statusMessage = "telemetry interrupted at plugin shutdown"
                entry.dirty = true
              }
            }
            interruptRunningTools(st, "plugin.shutdown")
            interruptRunningCompactions(st, "plugin.shutdown")
          }
          // Finish accepted state work within the budget.
          await Promise.race([Promise.allSettled([...stateChains.values()].map((p) => p.catch(noop))), deadlinePromise])
          // Work accepted before shutdown may have created new observations:
          // mark anything still running interrupted, then drain the exports.
          for (const st of states.values()) {
            for (const entry of st.generations.values()) {
              if (entry.record.captureStatus === "running") {
                entry.record.captureStatus = "interrupted"
                entry.record.statusMessage = "telemetry interrupted at plugin shutdown"
                entry.dirty = true
              }
            }
            interruptRunningTools(st, "plugin.shutdown")
            interruptRunningCompactions(st, "plugin.shutdown")
          }
          // Drain dirty batches and in-flight ingestion, aborting at expiry.
          await Promise.race([
            Promise.allSettled(
              [...states.keys()].map((sessionID) => runExportChain(sessionID, controller.signal).catch(noop)),
            ),
            deadlinePromise,
          ])
          await Promise.race([
            Promise.allSettled([...exportChains.values()].map((p) => p.catch(noop))),
            deadlinePromise,
          ])
          if (aborted) {
            const unsettled = [...states.values()].filter(
              (st) => st.rootDirty || pendingGenerationCount(st) > 0 || pendingToolCount(st) > 0 || pendingCompactionCount(st) > 0,
            ).length
            if (unsettled > 0) {
              const text = `Shutdown drain incomplete for ${unsettled} session(s) after ${shutdownTimeoutMs}ms`
              log(text)
              try {
                onError?.(text)
              } catch {
                // Observer failures never alter cleanup.
              }
            }
          }
        } finally {
          if (deadlineHandle !== undefined) {
            clearTimeout(deadlineHandle)
          }
        }
      })()
      return shutdownPromise
    },
  }
}
