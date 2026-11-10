/**
 * Per-session trace state, generation acquisition, and export lifetime.
 *
 * One trace per primary OpenCode session (children are feature-013). Identity
 * is deterministic from the session id, so a continued, flushed, or
 * reconstructed session reuses the same trace/root/generation ids. The
 * durable event stream is the only truth for primaries
 * (`session.step.*`, `session.execution.*`, prompts, final assistant text);
 * auxiliary exchanges (title/compaction/generate) arrive through exact
 * Request-identity HTTP hooks. State work is serialized per session and never
 * awaited from the event path; exports run on their own per-session chain.
 */

import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { observeAuxiliaryResponse, type AuxiliaryCompletion, type ObservedAuxiliaryResponse } from "./auxiliary.js"
import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import {
  FLUSH_GRACE_MS,
  GENERATION_SEED_PREFIX,
  LANGFUSE_SESSION_ID_MAX,
  MAX_PENDING_GENERATIONS_PER_SESSION,
  MAX_STRING_LENGTH,
  MAX_TRACKED_SESSIONS,
  ROOT_SEED_PREFIX,
  SHUTDOWN_TIMEOUT_MS,
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
import { redactValue } from "./redaction.js"

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
  }),
)

const stepFailedSchema = stepKeySchema.and(
  z.object({
    error: z
      .object({ message: z.string().optional() })
      .loose()
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

export interface SessionSnapshot {
  parentID?: string
  createdAt?: number
  firstPrompt?: string
  latestAssistantOutput?: string
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

export interface TrackerOptions {
  transport: LangfuseTransport
  policy: CapturePolicy
  flushDelayMs?: number
  shutdownTimeoutMs?: number
  newId?: () => string
  now?: () => number
  log?: (message: string) => void
  /** Cold-load reconciliation: children (parentID) are skipped; failure fails open. */
  lookupSession?(sessionID: string): Promise<SessionSnapshot | undefined>
  /** Targeted recovery of one missing primary start from the transcript. */
  lookupAssistant?(sessionID: string, assistantMessageID: string): Promise<AssistantSnapshot | undefined>
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

interface SessionState {
  sessionID: string
  identity: SessionIdentity
  createdAt?: number
  firstPrompt?: string
  latestAssistantOutput?: string
  rootDirty: boolean
  rootExported: boolean
  rootEndedAt?: number
  auxTerminalMax?: number
  generations: Map<string, GenEntry>
  refusedGenerations: Set<string>
  capacityWarned: boolean
  exportTimer?: ReturnType<typeof setTimeout>
  exportDeadline?: number
  exporting: boolean
  lastActiveAt: number
  seenDurableSeqs: Set<number>
  seenEventIds: Set<string>
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
  "session.execution.succeeded": true,
  "session.execution.failed": true,
  "session.execution.interrupted": true,
  "session.step.started": true,
  "session.step.streamed": true,
  "session.step.ended": true,
  "session.step.failed": true,
}

const MAX_SEEN_SEQS = 8192
const MAX_EXCLUDED_SESSIONS = 1024
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

/** Limits + redaction applied before recovered root content is retained. */
function boundRecovered(value: string): string {
  return truncate(value, MAX_STRING_LENGTH)
}

export function createTracker(options: TrackerOptions): Tracker {
  const transport = options.transport
  const policy = options.policy
  const flushDelayMs = options.flushDelayMs ?? FLUSH_GRACE_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const newId = options.newId ?? randomUUID
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string) => console.warn(`📊 Langfuse: ${message}`))
  const lookupSession = options.lookupSession
  const lookupAssistant = options.lookupAssistant

  const states = new Map<string, SessionState>()
  const stateChains = new Map<string, Promise<void>>()
  const exportChains = new Map<string, Promise<void>>()
  const excludedSessions = new Set<string>()
  const sessionCapacityWarned = new Set<string>()
  // Queued-but-unfinished state work per session, tracked outside the state
  // record so pre-state enqueues and in-flight reconciles are never mistaken
  // for clean inactive sessions.
  const pendingWorkBySession = new Map<string, number>()
  const auxByRequest = new WeakMap<Request, AuxDescriptor>()
  const liveAux = new Set<AuxDescriptor>()

  let closed = false
  let shutdownPromise: Promise<void> | undefined

  function diagnostic(message: string): void {
    log(truncate(String(redactValue(message)), DIAGNOSTIC_LIMIT))
  }

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

  function isCleanInactive(st: SessionState): boolean {
    return (
      !st.rootDirty &&
      !st.exporting &&
      (pendingWorkBySession.get(st.sessionID) ?? 0) === 0 &&
      pendingGenerationCount(st) === 0
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

  /** Resets a refusal episode once capacity is available again. */
  function resetCapacityEpisode(st: SessionState): void {
    if (pendingGenerationCount(st) < MAX_PENDING_GENERATIONS_PER_SESSION) {
      st.capacityWarned = false
      st.refusedGenerations.clear()
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
    if (snapshot?.firstPrompt !== undefined && st.firstPrompt === undefined) {
      st.firstPrompt = boundRecovered(snapshot.firstPrompt)
    }
    if (snapshot?.latestAssistantOutput !== undefined && st.latestAssistantOutput === undefined) {
      st.latestAssistantOutput = boundRecovered(snapshot.latestAssistantOutput)
    }
  }

  /** Cold-load reconciliation; runs inside the per-session state chain. */
  async function reconcile(sessionID: string, eventCreated: number, allowCreate: boolean): Promise<SessionState | undefined> {
    const existing = states.get(sessionID)
    if (existing) {
      return existing
    }
    if (excludedSessions.has(sessionID)) {
      return undefined
    }
    let snapshot: SessionSnapshot | undefined
    try {
      snapshot = await lookupSession?.(sessionID)
    } catch (error) {
      log(`Failed to look up session ${sessionID} (treating as primary): ${truncate(String(error), DIAGNOSTIC_LIMIT)}`)
      snapshot = undefined
    }
    // A lookup completing after shutdown must not recreate records or restart
    // timers; work accepted before shutdown still finishes.
    if (closed && !allowCreate) {
      return undefined
    }
    if (typeof snapshot?.parentID === "string" && snapshot.parentID.length > 0) {
      excludedSessions.add(sessionID)
      if (excludedSessions.size > MAX_EXCLUDED_SESSIONS) {
        const oldest = excludedSessions.values().next().value
        if (oldest !== undefined) {
          excludedSessions.delete(oldest)
        }
      }
      return undefined
    }
    const st = admitSession(sessionID)
    if (!st) {
      return undefined
    }
    markRootRecovered(st, snapshot, eventCreated)
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
      log(`Failed to look up assistant ${assistantMessageID}: ${truncate(String(error), DIAGNOSTIC_LIMIT)}`)
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

  function handleStepEnded(
    st: SessionState,
    data: z.infer<typeof stepEndedSchema>,
    created: number,
    recoveredStreamedAt: number | undefined,
  ): void {
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    const entry = st.generations.get(observationId)
    if (!entry || entry.record.captureStatus !== "running") {
      return
    }
    entry.record.finishReason = data.finish
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
    entry.dirty = true
    requestExport(st)
  }

  function handleStepFailed(st: SessionState, data: z.infer<typeof stepFailedSchema>, created: number): void {
    const observationId = primaryObservationId(st.sessionID, data.assistantMessageID)
    const entry = st.generations.get(observationId)
    if (!entry || entry.record.captureStatus !== "running") {
      return
    }
    entry.record.captureStatus = "error"
    entry.record.endTime = created
    entry.record.endBoundary = "session.step.failed"
    entry.record.statusMessage = truncate(String(data.error?.message ?? "step failed"), DIAGNOSTIC_LIMIT)
    // Host cost/tokens are never imported into this feature's output.
    entry.dirty = true
    requestExport(st)
  }

  function markExecutionTerminal(st: SessionState, created: number): void {
    if (st.rootEndedAt === undefined) {
      st.rootEndedAt = created
    }
    st.rootDirty = true
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
        const captured = applyCapturePolicy(
          {
            input: st.firstPrompt,
            output: st.latestAssistantOutput,
            metadata: { sessionId: st.sessionID, completed: st.rootEndedAt !== undefined },
          },
          policy,
        )
        const startIso = toIso(st.createdAt)
        const endMs =
          st.rootEndedAt !== undefined ? Math.max(st.rootEndedAt, st.auxTerminalMax ?? st.rootEndedAt) : undefined
        const endIso = toIso(endMs)
        const langfuseSessionId = truncate(st.sessionID, LANGFUSE_SESSION_ID_MAX)

        const traceBody: Record<string, unknown> = {
          id: st.identity.traceId,
          name: TRACE_NAME,
          sessionId: langfuseSessionId,
          metadata: captured.metadata,
        }
        if (startIso !== undefined) {
          traceBody.timestamp = startIso
        }
        if (captured.input !== undefined) {
          traceBody.input = captured.input
        }
        if (captured.output !== undefined) {
          traceBody.output = captured.output
        }
        events.push({ id: newId(), type: "trace-create", timestamp: new Date(emittedAt).toISOString(), body: traceBody })

        const spanBody: Record<string, unknown> = {
          id: st.identity.rootObservationId,
          traceId: st.identity.traceId,
          name: TRACE_NAME,
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

      const result = await transport.ingest(events, signal ? { signal } : undefined)
      if (result.failed > 0) {
        log(`Failed to persist ${result.failed}/${events.length} event(s) for session ${sessionID}`)
      }
      resetCapacityEpisode(st)
      pruneSettledGenerations(st)
      if (pendingGenerationCount(st) > 0 || st.rootDirty) {
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
        st.auxTerminalMax = Math.max(st.auxTerminalMax ?? completion.at, completion.at)
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
      // Native session.created carries parentID directly: children never get
      // state, lookups, or generations.
      if (type === "session.created" && isRecord(envelope.data.data)) {
        const parentID = envelope.data.data.parentID
        if (typeof parentID === "string" && parentID.length > 0) {
          excludedSessions.add(sessionID)
          if (excludedSessions.size > MAX_EXCLUDED_SESSIONS) {
            const oldest = excludedSessions.values().next().value
            if (oldest !== undefined) {
              excludedSessions.delete(oldest)
            }
          }
          return Promise.resolve()
        }
      }
      return enqueueState(sessionID, async () => {
        // The event was accepted before this task ran, so its session may still
        // be created even when shutdown began in the meantime.
        const st = await reconcile(sessionID, created, true)
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
            const observationId = primaryObservationId(sessionID, parsed.data.assistantMessageID)
            let recoveredStreamedAt: number | undefined
            if (!st.generations.has(observationId)) {
              const recovered = await missingStart(st, parsed.data.assistantMessageID)
              if (!recovered) {
                return
              }
              recoveredStreamedAt = recovered.recoveredStreamedAt
            }
            handleStepEnded(st, parsed.data, created, recoveredStreamedAt)
            break
          }
          case "session.step.failed": {
            const parsed = stepFailedSchema.safeParse(envelope.data.data)
            if (!parsed.success) {
              diagnostic(`malformed session.step.failed for ${sessionID}`)
              return
            }
            const observationId = primaryObservationId(sessionID, parsed.data.assistantMessageID)
            if (!st.generations.has(observationId)) {
              const recovered = await missingStart(st, parsed.data.assistantMessageID)
              if (!recovered) {
                return
              }
            }
            handleStepFailed(st, parsed.data, created)
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
        if (st.rootDirty || st.exporting || (pendingWorkBySession.get(st.sessionID) ?? 0) > 0 || pendingGenerationCount(st) > 0) {
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
              (st) => st.rootDirty || pendingGenerationCount(st) > 0,
            ).length
            if (unsettled > 0) {
              log(`Shutdown drain incomplete for ${unsettled} session(s) after ${shutdownTimeoutMs}ms`)
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
