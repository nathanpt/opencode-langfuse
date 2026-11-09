/**
 * Per-session trace state and flush lifecycle.
 *
 * One trace per primary OpenCode session (children are feature-003). The
 * durable event stream is the only truth: `session.inbox.enqueued` for the
 * user prompt, `session.text.ended` for the final assistant response,
 * `session.execution.succeeded` (+ grace window) as the flush boundary.
 * Buffers are self-bounded and flush is at-most-once: the record is dropped
 * from the map before the ingest attempt fires.
 */

import { randomUUID } from "node:crypto"
import { applyCapturePolicy, type CapturePolicy } from "./capture-policy.js"
import { FLUSH_GRACE_MS, LANGFUSE_SESSION_ID_MAX, TRACE_NAME } from "./constants.js"
import type { IngestEvent, LangfuseTransport } from "./langfuse.js"
import { isRecord } from "./guards.js"

export interface TracingEvent {
  type: string
  created?: number
  data?: unknown
}

interface SessionRecord {
  traceId: string
  rootSpanId: string
  startedAt: number
  prompt: string | undefined
  output: string | undefined
  flushTimer: ReturnType<typeof setTimeout> | undefined
}

export interface TrackerOptions {
  transport: LangfuseTransport
  policy: CapturePolicy
  flushDelayMs?: number
  newId?: () => string
  now?: () => number
  log?: (message: string) => void
  /** Resolves the session's parentID (children are skipped); undefined = primary or unknown. */
  lookupParentID?(sessionId: string): Promise<string | undefined>
}

export interface Tracker {
  /** Returns a promise only while a record reconciliation is in flight. */
  handleEvent(event: TracingEvent): Promise<void> | void
  flushNow(sessionId: string): Promise<void>
  flushAll(): Promise<void>
  pendingSessionIds(): string[]
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const raw = value[key]
  return typeof raw === "string" ? raw : undefined
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value
}

function toIso(epochMs: number | undefined, fallback: number): string {
  return new Date(epochMs ?? fallback).toISOString()
}

export function createTracker(options: TrackerOptions): Tracker {
  const transport = options.transport
  const policy = options.policy
  const flushDelayMs = options.flushDelayMs ?? FLUSH_GRACE_MS
  const newId = options.newId ?? randomUUID
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string) => console.warn(`📊 Langfuse: ${message}`))
  const lookupParentID = options.lookupParentID
  const records = new Map<string, SessionRecord>()
  const creating = new Map<string, Promise<void>>()

  function createRecord(sessionId: string, startedAt: number): SessionRecord {
    const record: SessionRecord = {
      traceId: newId(),
      rootSpanId: newId(),
      startedAt,
      prompt: undefined,
      output: undefined,
      flushTimer: undefined,
    }
    records.set(sessionId, record)
    return record
  }

  /**
   * `session.created` can race the event subscription (first session after a
   * plugin load), so a prompt for an unknown session reconciles against the
   * session API: primaries become records, children stay skipped. Lookup
   * failure fails open (record created) so data is never silently lost.
   */
  async function ensureRecordForPrompt(sessionId: string, startedAt: number, prompt: string): Promise<void> {
    const pending = creating.get(sessionId)
    if (pending) {
      await pending
    } else {
      const task = (async () => {
        if (records.has(sessionId)) {
          return
        }
        let parentID: string | undefined
        try {
          parentID = await lookupParentID?.(sessionId)
        } catch (error) {
          log(`Failed to look up session ${sessionId} (treating as primary): ${String(error)}`)
          parentID = undefined
        }
        if (parentID === undefined && !records.has(sessionId)) {
          createRecord(sessionId, startedAt)
        }
      })()
      creating.set(sessionId, task)
      try {
        await task
      } finally {
        creating.delete(sessionId)
      }
    }
    const record = records.get(sessionId)
    if (record) {
      record.prompt ??= prompt
    }
  }

  function readInboxPrompt(data: unknown): string | undefined {
    if (!isRecord(data) || !isRecord(data.item)) {
      return undefined
    }
    const item = data.item
    if (item.type !== "user" || !isRecord(item.payload)) {
      return undefined
    }
    const text = item.payload.text
    return typeof text === "string" ? text : undefined
  }

  function buildEvents(sessionId: string, record: SessionRecord, endedAt: number): IngestEvent[] {
    const captured = applyCapturePolicy(
      {
        input: record.prompt,
        output: record.output,
        metadata: { sessionId: sessionId, completed: true },
      },
      policy,
    )

    const startIso = toIso(record.startedAt, endedAt)
    const endIso = new Date(endedAt).toISOString()
    const langfuseSessionId = truncate(sessionId, LANGFUSE_SESSION_ID_MAX)

    const traceBody: Record<string, unknown> = {
      id: record.traceId,
      timestamp: startIso,
      name: TRACE_NAME,
      sessionId: langfuseSessionId,
      metadata: captured.metadata,
    }
    if (captured.input !== undefined) {
      traceBody.input = captured.input
    }
    if (captured.output !== undefined) {
      traceBody.output = captured.output
    }

    const spanBody: Record<string, unknown> = {
      id: record.rootSpanId,
      traceId: record.traceId,
      name: TRACE_NAME,
      startTime: startIso,
      endTime: endIso,
      level: "DEFAULT",
      metadata: captured.metadata,
    }
    if (captured.input !== undefined) {
      spanBody.input = captured.input
    }
    if (captured.output !== undefined) {
      spanBody.output = captured.output
    }

    return [
      { id: newId(), type: "trace-create", timestamp: startIso, body: traceBody },
      { id: newId(), type: "span-create", timestamp: endIso, body: spanBody },
    ]
  }

  async function flushSession(sessionId: string): Promise<void> {
    const record = records.get(sessionId)
    if (!record) {
      return
    }
    records.delete(sessionId)
    clearTimeout(record.flushTimer)

    const events = buildEvents(sessionId, record, now())
    const result = await transport.ingest(events)
    if (result.failed > 0) {
      log(`Failed to persist ${result.failed}/${events.length} event(s) for session ${sessionId}`)
    }
  }

  function scheduleFlush(sessionId: string, record: SessionRecord): void {
    if (record.flushTimer !== undefined) {
      return
    }
    record.flushTimer = setTimeout(() => {
      record.flushTimer = undefined
      void flushSession(sessionId)
    }, flushDelayMs)
    record.flushTimer.unref?.()
  }

  return {
    handleEvent(event: TracingEvent): Promise<void> | void {
      const sessionId = readString(event.data, "sessionID")
      if (!sessionId) {
        return
      }

      switch (event.type) {
        case "session.created": {
          if (readString(event.data, "parentID")) {
            return
          }
          if (!records.has(sessionId)) {
            createRecord(sessionId, event.created ?? now())
          }
          return
        }
        case "session.inbox.enqueued": {
          const prompt = readInboxPrompt(event.data)
          if (prompt === undefined) {
            return
          }
          const record = records.get(sessionId)
          if (record) {
            record.prompt ??= prompt
            return
          }
          return ensureRecordForPrompt(sessionId, event.created ?? now(), prompt)
        }
        case "session.text.ended": {
          const text = readString(event.data, "text")
          const record = records.get(sessionId)
          if (text === undefined || !record) {
            return
          }
          record.output = text
          return
        }
        case "session.execution.succeeded": {
          const record = records.get(sessionId)
          if (!record) {
            return
          }
          scheduleFlush(sessionId, record)
          return
        }
        default:
      }
    },

    async flushNow(sessionId: string): Promise<void> {
      await flushSession(sessionId)
    },

    async flushAll(): Promise<void> {
      const pending = [...records.keys()]
      await Promise.all(pending.map((sessionId) => flushSession(sessionId)))
    },

    pendingSessionIds(): string[] {
      return [...records.keys()]
    },
  }
}
