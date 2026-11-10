import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, IngestResult, LangfuseTransport } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver } from "../src/pricing.js"
import type { SessionSnapshot, Tracker, TrackerOptions } from "../src/tracker.js"
import { createTracker } from "../src/tracker.js"
import { buildToolEvent, toolObservationId } from "../src/tools.js"

const BASE = 1_700_000_000_000
const SID = "ses_tool_a1b2c3d4"
const SID2 = "ses_tool_e5f6a7b8"

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>
const POLICY = createCapturePolicy({ preset: "conversations", env: FULL_ENV })
const FULL_POLICY = createCapturePolicy({ preset: "full-debug", env: FULL_ENV })

interface FakeTransport extends LangfuseTransport {
  batches: IngestEvent[][]
  gated: (() => void)[]
}

/** Ingest resolver the test holds manually (for held-POST ordering proofs). */
function holdingTransport(): FakeTransport {
  const batches: IngestEvent[][] = []
  const gated: (() => void)[] = []
  return {
    batches,
    gated,
    async ingest(events: IngestEvent[]): Promise<IngestResult> {
      batches.push(events)
      await new Promise<void>((resolve) => gated.push(resolve))
      return { accepted: events.length, failed: 0 }
    },
  }
}

function fakeTransport(): FakeTransport {
  const batches: IngestEvent[][] = []
  return {
    batches,
    gated: [],
    async ingest(events: IngestEvent[]): Promise<IngestResult> {
      batches.push(events)
      return { accepted: events.length, failed: 0 }
    },
  }
}

function testPricing(): PricingResolver {
  return createPricingResolver({ loadCatalog: async () => ({ data: [] }), log: () => {} })
}

function makeTracker(
  transport: FakeTransport,
  overrides: Partial<TrackerOptions> = {},
  logs: string[] = [],
): Tracker {
  let seq = 0
  return createTracker({
    transport,
    policy: POLICY,
    pricing: testPricing(),
    flushDelayMs: 5,
    newId: () => `id-${(seq += 1)}`,
    now: () => BASE + 10_000,
    log: (message: string) => logs.push(message),
    ...overrides,
  })
}

type EventInput = Record<string, unknown>

function ev(type: string, created: number, data: EventInput, seq?: number): EventInput {
  return {
    type,
    created,
    ...(seq !== undefined ? { durable: { aggregateID: SID, seq, version: 1 } } : {}),
    data,
  }
}

function evFor(sessionID: string, type: string, created: number, data: EventInput, seq?: number): EventInput {
  const event = ev(type, created, { ...data, sessionID }, seq)
  if (event.durable !== undefined) {
    ;(event.durable as EventInput).aggregateID = sessionID
  }
  return event
}

function toolInputStarted(
  name: string,
  opts: { assistantMessageID?: string; id?: string; created?: number; seq?: number; sessionID?: string } = {},
): EventInput {
  const data = {
    assistantMessageID: opts.assistantMessageID ?? "msg_1",
    id: opts.id ?? "call_1",
    name,
  }
  return opts.sessionID !== undefined
    ? evFor(opts.sessionID, "session.tool.input.started", opts.created ?? BASE + 205, data, opts.seq)
    : ev("session.tool.input.started", opts.created ?? BASE + 205, { sessionID: SID, ...data }, opts.seq)
}

function toolCalled(
  opts: { assistantMessageID?: string; id?: string; input?: unknown; created?: number; seq?: number; sessionID?: string } = {},
): EventInput {
  const data = {
    assistantMessageID: opts.assistantMessageID ?? "msg_1",
    id: opts.id ?? "call_1",
    input: opts.input ?? { command: "echo hi" },
    executed: false,
  }
  return opts.sessionID !== undefined
    ? evFor(opts.sessionID, "session.tool.called", opts.created ?? BASE + 210, data, opts.seq)
    : ev("session.tool.called", opts.created ?? BASE + 210, { sessionID: SID, ...data }, opts.seq)
}

function toolSuccess(
  opts: {
    assistantMessageID?: string
    id?: string
    content?: unknown
    metadata?: Record<string, unknown>
    created?: number
    seq?: number
    sessionID?: string
  } = {},
): EventInput {
  const data: EventInput = {
    assistantMessageID: opts.assistantMessageID ?? "msg_1",
    id: opts.id ?? "call_1",
    content: opts.content ?? [{ type: "text", text: "done" }],
    metadata: opts.metadata ?? {},
    executed: false,
  }
  return opts.sessionID !== undefined
    ? evFor(opts.sessionID, "session.tool.success", opts.created ?? BASE + 260, data, opts.seq)
    : ev("session.tool.success", opts.created ?? BASE + 260, { sessionID: SID, ...data }, opts.seq)
}

function toolFailed(
  opts: {
    assistantMessageID?: string
    id?: string
    message?: string
    created?: number
    seq?: number
    sessionID?: string
  } = {},
): EventInput {
  const data: EventInput = {
    assistantMessageID: opts.assistantMessageID ?? "msg_1",
    id: opts.id ?? "call_1",
    error: { type: "tool.execution", message: opts.message ?? "tool exploded" },
    executed: false,
  }
  return opts.sessionID !== undefined
    ? evFor(opts.sessionID, "session.tool.failed", opts.created ?? BASE + 260, data, opts.seq)
    : ev("session.tool.failed", opts.created ?? BASE + 260, { sessionID: SID, ...data }, opts.seq)
}

function afterHook(
  opts: {
    tool?: string
    messageID?: string
    id?: string
    status?: "completed" | "error"
    input?: unknown
    result?: unknown
    error?: unknown
    sessionID?: string
  } = {},
): EventInput {
  return {
    tool: opts.tool ?? "shell",
    sessionID: opts.sessionID ?? SID,
    messageID: opts.messageID ?? "msg_1",
    id: opts.id ?? "call_1",
    input: opts.input ?? { command: "echo hi" },
    status: opts.status ?? "completed",
    ...(opts.status === "error" || opts.error !== undefined
      ? { error: opts.error ?? { message: "tool exploded" } }
      : { result: opts.result ?? { content: [{ type: "text", text: "done" }] } }),
  }
}

function inboxPrompt(text: string, seq = 1): EventInput {
  return ev("session.inbox.enqueued", BASE + 100, { sessionID: SID, item: { type: "user", payload: { text } } }, seq)
}

function executionSucceeded(created = BASE + 400, seq = 9): EventInput {
  return ev("session.execution.succeeded", created, { sessionID: SID }, seq)
}

function executionInterrupted(created = BASE + 400, seq = 9): EventInput {
  return ev("session.execution.interrupted", created, { sessionID: SID, reason: "user" }, seq)
}

/** Tool span bodies (span-create/span-update with metadata.kind "tool"). */
function toolSpans(events: IngestEvent[]): IngestEvent[] {
  return events.filter(
    (e) => (e.type === "span-create" || e.type === "span-update") && (e.body.metadata as EventInput)?.kind === "tool",
  )
}

function rootSpans(events: IngestEvent[]): IngestEvent[] {
  return events.filter((e) => e.type === "span-create" || e.type === "span-update")
}

function spanById(events: IngestEvent[], id: string): IngestEvent[] {
  return events.filter((e) => e.body.id === id)
}

async function settleTimers(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test("tool observation ids follow the documented hash convention", () => {
  const expected = createHash("sha256")
    .update(`opencode-langfuse:tool:${SID}:msg_1:call_1`, "utf8")
    .digest("hex")
    .slice(0, 16)
  assert.equal(toolObservationId(SID, "msg_1", "call_1"), expected)
})

test("successful output containing the word error stays successful", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(inboxPrompt("run checks"))
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1" }))
  tracker.handleToolAfter(
    afterHook({ id: "call_1", result: { content: [{ type: "text", text: "error: synthetic benign text" }] } }),
  )
  await tracker.flushNow(SID)

  const spans = toolSpans(transport.batches.flat())
  assert.equal(spans.length, 1)
  const body = spans[0].body
  assert.equal(body.level, "DEFAULT")
  assert.equal(body.name, "shell")
  assert.equal((body.metadata as EventInput).isError, false)
  assert.equal((body.metadata as EventInput).captureStatus, "completed")
  assert.equal((body.metadata as EventInput).nativeStatus, "completed")
  assert.equal((body.metadata as EventInput).outcomeSource, "execute.after")
  assert.equal((body.metadata as EventInput).exitCode, undefined)
  assert.match(String(body.output), /error: synthetic benign text/)
})

test("completed native shell status with numeric exit 7 is ERROR, native status preserved", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1" }))
  tracker.handleToolAfter(
    afterHook({ id: "call_1", result: { content: [{ type: "text", text: "feature069-nonzero" }], metadata: { exit: 7 } } }),
  )
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.level, "ERROR")
  assert.equal((body.metadata as EventInput).nativeStatus, "completed")
  assert.equal((body.metadata as EventInput).captureStatus, "error")
  assert.equal((body.metadata as EventInput).isError, true)
  assert.equal((body.metadata as EventInput).exitCode, 7)
  assert.equal(body.statusMessage, "shell exited with code 7")
})

test("durable success metadata.exit drives the same classification when the hook was missed", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1" }))
  tracker.handleEvent(toolSuccess({ id: "call_1", metadata: { exit: 7 }, content: [{ type: "text", text: "boom" }] }))
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.level, "ERROR")
  assert.equal((body.metadata as EventInput).nativeStatus, "completed")
  assert.equal((body.metadata as EventInput).outcomeSource, "session.tool.success")
  assert.equal((body.metadata as EventInput).exitCode, 7)
  assert.equal((body.metadata as EventInput).endBoundary, "session.tool.success")
})

test("string, missing, and non-finite exit values never classify a shell failure", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  for (const [i, exit] of ["7", NaN, undefined].entries()) {
    tracker.handleEvent(toolInputStarted("shell", { id: `call_${i}`, seq: i * 10 }))
    tracker.handleEvent(toolCalled({ id: `call_${i}`, seq: i * 10 + 1 }))
    tracker.handleToolAfter(
      afterHook({ id: `call_${i}`, result: { content: [{ type: "text", text: "ok" }], metadata: exit === undefined ? {} : { exit } } }),
    )
  }
  await tracker.flushNow(SID)

  const spans = toolSpans(transport.batches.flat())
  assert.equal(spans.length, 3)
  for (const span of spans) {
    assert.equal(span.body.level, "DEFAULT", `exit ${String((span.body.metadata as EventInput).exitCode)} must stay DEFAULT`)
    assert.equal((span.body.metadata as EventInput).exitCode, undefined)
  }
})

test("a structured error hook status is ERROR regardless of innocuous output", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("read", { id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1" }))
  tracker.handleToolAfter(
    afterHook({
      id: "call_1",
      tool: "read",
      status: "error",
      error: { message: "disk briefly busy" },
      result: { content: [{ type: "text", text: "all good" }] },
    }),
  )
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.level, "ERROR")
  assert.equal((body.metadata as EventInput).nativeStatus, "error")
  assert.equal((body.metadata as EventInput).isError, true)
  // With tool I/O capture on, the bounded redacted native message is exported.
  assert.equal(body.statusMessage, "disk briefly busy")
})

test("fixed failure text replaces the native message while tool I/O capture is off", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: POLICY })
  tracker.handleEvent(toolInputStarted("read", { id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1" }))
  tracker.handleToolAfter(afterHook({ id: "call_1", tool: "read", status: "error", error: { message: "disk briefly busy" } }))
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.statusMessage, "tool execution failed")
  assert.equal(body.output, undefined)
})

test("each independent same-name call keeps its own observation", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  tracker.handleEvent(toolInputStarted("shell", { id: "call_2", seq: 3 }))
  tracker.handleEvent(toolCalled({ id: "call_2", seq: 4 }))
  tracker.handleToolAfter(afterHook({ id: "call_1" }))
  tracker.handleToolAfter(
    afterHook({ id: "call_2", status: "error", error: { message: "second failed" } }),
  )
  await tracker.flushNow(SID)

  const spans = toolSpans(transport.batches.flat())
  assert.equal(spans.length, 2)
  const ids = new Set(spans.map((s) => s.body.id))
  assert.equal(ids.size, 2)
  const outcomes = spans.map((s) => s.body.level).sort()
  assert.deepEqual(outcomes, ["DEFAULT", "ERROR"])
  const callIds = new Set(spans.map((s) => (s.body.metadata as EventInput).toolCallID))
  assert.deepEqual([...callIds].sort(), ["call_1", "call_2"])
})

test("identical provider call ids on distinct assistants and sessions never collide", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { assistantMessageID: "msg_1", id: "call_dup", seq: 1 }))
  tracker.handleEvent(toolCalled({ assistantMessageID: "msg_1", id: "call_dup", seq: 2 }))
  tracker.handleEvent(toolSuccess({ assistantMessageID: "msg_1", id: "call_dup", seq: 3 }))
  tracker.handleEvent(toolInputStarted("shell", { assistantMessageID: "msg_2", id: "call_dup", seq: 4 }))
  tracker.handleEvent(toolCalled({ assistantMessageID: "msg_2", id: "call_dup", seq: 5 }))
  tracker.handleEvent(toolFailed({ assistantMessageID: "msg_2", id: "call_dup", seq: 6 }))
  tracker.handleEvent(evFor(SID2, "session.created", BASE, { sessionID: SID2 }, 0))
  tracker.handleEvent(toolInputStarted("shell", { sessionID: SID2, id: "call_dup", seq: 1, created: BASE + 205 }))
  tracker.handleEvent(toolCalled({ sessionID: SID2, id: "call_dup", seq: 2, created: BASE + 210 }))
  tracker.handleEvent(toolSuccess({ sessionID: SID2, id: "call_dup", seq: 3, created: BASE + 260 }))
  await tracker.flushNow(SID)
  await tracker.flushNow(SID2)

  const spans = toolSpans(transport.batches.flat())
  assert.equal(spans.length, 3)
  assert.equal(new Set(spans.map((s) => s.body.id)).size, 3)
})

test("reversed completion order matches each outcome to its own call", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  tracker.handleEvent(toolInputStarted("shell", { id: "call_2", seq: 3 }))
  tracker.handleEvent(toolCalled({ id: "call_2", seq: 4 }))
  tracker.handleEvent(toolFailed({ id: "call_2", seq: 5, message: "second failed first" }))
  tracker.handleEvent(toolSuccess({ id: "call_1", seq: 6 }))
  await tracker.flushNow(SID)

  const spans = toolSpans(transport.batches.flat())
  assert.equal(spans.length, 2)
  const byCall = new Map(spans.map((s) => [(s.body.metadata as EventInput).toolCallID, s]))
  assert.equal(byCall.get("call_1")?.body.level, "DEFAULT")
  assert.equal(byCall.get("call_2")?.body.level, "ERROR")
  assert.equal(byCall.get("call_2")?.body.statusMessage, "tool execution failed")
})

test("a terminal fact without called admits one call with no fabricated start time", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_late", seq: 1 }))
  tracker.handleEvent(toolSuccess({ id: "call_late", seq: 2, content: [{ type: "text", text: "done" }] }))
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.startTime, undefined)
  assert.equal((body.metadata as EventInput).startBoundary, "unavailable")
  assert.equal((body.metadata as EventInput).endBoundary, "session.tool.success")
  assert.equal(body.level, "DEFAULT")
})

test("duplicate called/after/terminal facts never create a second observation or reset the outcome", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, { policy: FULL_POLICY }, logs)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 3 }))
  tracker.handleToolAfter(
    afterHook({ id: "call_1", result: { content: [{ type: "text", text: "ok" }], metadata: { exit: 3 } } }),
  )
  tracker.handleToolAfter(
    afterHook({ id: "call_1", result: { content: [{ type: "text", text: "ok again" }] } }),
  )
  tracker.handleEvent(toolSuccess({ id: "call_1", seq: 4, created: BASE + 300 }))
  tracker.handleEvent(toolSuccess({ id: "call_1", seq: 5, created: BASE + 310 }))
  await tracker.flushNow(SID)

  const events = transport.batches.flat()
  const creates = events.filter((e) => e.type === "span-create" && (e.body.metadata as EventInput)?.kind === "tool")
  assert.equal(creates.length, 1, "exactly one span-create for the identity")
  const finalBody = spanById(events, creates[0].body.id as string).at(-1)!.body
  // The hook outcome (exit 3 → ERROR) is never reset by the duplicates.
  assert.equal(finalBody.level, "ERROR")
  assert.equal((finalBody.metadata as EventInput).exitCode, 3)
  assert.equal((finalBody.metadata as EventInput).outcomeSource, "execute.after")
  assert.equal((finalBody.metadata as EventInput).endBoundary, "session.tool.success")
  assert.ok((finalBody.endTime as string) <= new Date(BASE + 300).toISOString())
})

test("a late hook after a durable terminal enriches the same record instead of creating one", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 0 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 1, input: { command: "early" } }))
  tracker.handleEvent(toolFailed({ id: "call_1", seq: 2, message: "native failed" }))
  await tracker.flushNow(SID)
  const afterFirst = toolSpans(transport.batches.flat()).length

  tracker.handleToolAfter(afterHook({ id: "call_1", status: "error", error: { message: "hook saw it too" } }))
  await tracker.flushNow(SID)

  const events = transport.batches.flat()
  const creates = events.filter((e) => e.type === "span-create" && (e.body.metadata as EventInput)?.kind === "tool")
  assert.equal(creates.length, 1)
  assert.ok(toolSpans(events).length > afterFirst, "an update was exported")
  const finalBody = spanById(events, creates[0].body.id as string).at(-1)!.body
  assert.equal(finalBody.level, "ERROR")
  // The hook merely confirms the durable outcome: the label stays with the
  // fact that delivered the terminal (no downgrade, no new observation).
  assert.equal((finalBody.metadata as EventInput).outcomeSource, "session.tool.failed")
  // The durable terminal's created time stays the preferred endTime.
  assert.equal((finalBody.metadata as EventInput).endBoundary, "session.tool.failed")
})

test("input.started alone records a name hint without creating an executed call", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1" }))
  await tracker.flushNow(SID)

  assert.equal(toolSpans(transport.batches.flat()).length, 0)
})

test("unnameable calls are omitted with one bounded diagnostic", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(toolFailed({ id: "call_ghost", message: "no name known" }))
  await tracker.flushNow(SID)

  assert.equal(toolSpans(transport.batches.flat()).length, 0)
  const diagnostics = logs.filter((m) => m.includes("name unavailable"))
  assert.equal(diagnostics.length, 1)
})

test("lookupTool recovers the name and start from the exact transcript part", async () => {
  const transport = fakeTransport()
  const lookedUp: string[] = []
  const tracker = makeTracker(transport, {
    policy: FULL_POLICY,
    lookupTool: async (_sessionID, assistantMessageID, toolCallID) => {
      lookedUp.push(`${assistantMessageID}/${toolCallID}`)
      return {
        name: "shell",
        input: { command: "recovered" },
        output: "recovered output",
        status: "completed",
        exit: 7,
        startedAt: BASE + 150,
        completedAt: BASE + 250,
      }
    },
  })
  tracker.handleEvent(toolFailed({ id: "call_1", message: "native failed" }))
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.deepEqual(lookedUp, ["msg_1/call_1"])
  assert.equal(body.name, "shell")
  assert.equal(body.startTime, new Date(BASE + 150).toISOString())
  assert.equal((body.metadata as EventInput).startBoundary, "transcript.tool.time")
  assert.equal((body.metadata as EventInput).endBoundary, "session.tool.failed")
  assert.equal((body.metadata as EventInput).exitCode, 7)
  assert.equal(body.level, "ERROR")
  assert.equal(body.input !== undefined, true)
  assert.equal(body.output, "recovered output")
})

test("interrupted execution is WARNING, not an invented tool error", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  tracker.handleEvent(executionInterrupted())
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.level, "WARNING")
  assert.equal((body.metadata as EventInput).captureStatus, "interrupted")
  assert.equal((body.metadata as EventInput).isError, undefined)
  assert.equal((body.metadata as EventInput).endBoundary, "session.execution.interrupted")
  assert.equal(body.statusMessage, "tool interrupted before completion")
})

test("late post-flush tool completion updates the same span and extends the root", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(inboxPrompt("run checks"))
  tracker.handleEvent(executionSucceeded(BASE + 400, 9))
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 10, created: BASE + 420 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 11, created: BASE + 425 }))
  await tracker.flushNow(SID)
  const batchesAfterFirst = transport.batches.length

  tracker.handleToolAfter(afterHook({ id: "call_1", result: { content: [{ type: "text", text: "late" }] } }))
  await tracker.flushNow(SID)

  const events = transport.batches.flat()
  const creates = events.filter((e) => e.type === "span-create" && (e.body.metadata as EventInput)?.kind === "tool")
  assert.equal(creates.length, 1)
  assert.ok(toolSpans(events).length >= 2, "a span-update followed")
  const roots = rootSpans(events).filter((e) => (e.body.metadata as EventInput)?.kind === undefined)
  const lastRoot = roots.at(-1)!.body
  assert.equal(lastRoot.endTime, new Date(BASE + 10_000).toISOString(), "root endTime covers the late tool terminal")
  assert.ok(transport.batches.length > batchesAfterFirst)
})

test("held ingestion submits the create snapshot unchanged, then the ordered update", async () => {
  const transport = holdingTransport()
  const tracker = makeTracker(transport, { policy: FULL_POLICY })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  const firstFlush = tracker.flushNow(SID)
  await settleTimers()
  // A terminal arrives while the first POST is still held.
  tracker.handleEvent(toolFailed({ id: "call_1", seq: 3, message: "failed later" }))
  const secondFlush = tracker.flushNow(SID)
  await settleTimers()

  assert.equal(transport.batches.length, 1, "second export waits for the held POST")
  const held = transport.batches[0].filter((e) => (e.body.metadata as EventInput)?.kind === "tool")
  assert.equal(held.length, 1)
  assert.equal(held[0].type, "span-create")
  assert.equal((held[0].body.metadata as EventInput).captureStatus, "running")
  assert.deepEqual(held[0].body.input, { command: "echo hi" })

  transport.gated[0]()
  await firstFlush
  await settleTimers()
  assert.equal(transport.batches.length, 2)
  const update = transport.batches[1].filter((e) => (e.body.metadata as EventInput)?.kind === "tool")
  assert.equal(update[0].type, "span-update")
  assert.equal(update[0].body.id, held[0].body.id)
  assert.equal((update[0].body.metadata as EventInput).captureStatus, "error")
  transport.gated[1]()
  await secondFlush
})

test("tool capacity refusal refuses telemetry once per episode and resets after drain", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  for (let i = 0; i < 256; i += 1) {
    tracker.handleEvent(toolInputStarted("shell", { id: `call_${i}`, seq: i * 3, created: BASE + 205 }))
    tracker.handleEvent(toolCalled({ id: `call_${i}`, seq: i * 3 + 1, created: BASE + 210 }))
  }
  tracker.handleEvent(toolCalled({ id: "call_overflow", seq: 768, created: BASE + 210 }))
  await tracker.flushNow(SID)

  const firstExport = toolSpans(transport.batches.flat())
  // The 256 admitted calls export as running spans; the 257th identity is refused entirely.
  assert.equal(firstExport.length, 256)
  assert.ok(!firstExport.some((e) => (e.body.metadata as EventInput).toolCallID === "call_overflow"))
  assert.equal(logs.filter((m) => m.includes("pending tool capacity reached")).length, 1)

  // Settle and drain everything: the refusal episode resets.
  for (let i = 0; i < 256; i += 1) {
    tracker.handleEvent(toolSuccess({ id: `call_${i}`, seq: 1000 + i * 2, created: BASE + 260 }))
  }
  await tracker.flushNow(SID)
  await tracker.flushNow(SID)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_after_reset", seq: 2000, created: BASE + 205 }))
  tracker.handleEvent(toolCalled({ id: "call_after_reset", seq: 2001, created: BASE + 210 }))
  tracker.handleEvent(toolSuccess({ id: "call_after_reset", seq: 2002, created: BASE + 260 }))
  await tracker.flushNow(SID)
  const exported = toolSpans(transport.batches.flat())
  assert.ok(exported.length >= 257, "all admitted calls exported after the reset")
  assert.ok(exported.some((e) => (e.body.metadata as EventInput).toolCallID === "call_after_reset"))
  assert.equal(toolSpans(transport.batches.flat()).filter((e) => (e.body.metadata as EventInput).toolCallID === "call_overflow").length, 0)
})

test("child sessions produce tool telemetry under their own trace", async () => {
  const transport = fakeTransport()
  const childSession = "ses_child_1"
  const tracker = makeTracker(transport, {
    lookupSession: async (sessionID): Promise<SessionSnapshot | undefined> =>
      sessionID === childSession ? { parentID: SID, agent: "general" } : undefined,
  })
  tracker.handleEvent(evFor(childSession, "session.created", BASE, { sessionID: childSession, parentID: SID }, 0))
  tracker.handleEvent(toolInputStarted("shell", { sessionID: childSession, id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ sessionID: childSession, id: "call_1", seq: 2, created: BASE + 210 }))
  tracker.handleEvent(toolSuccess({ sessionID: childSession, id: "call_1", seq: 3, created: BASE + 260 }))
  await tracker.flushNow(childSession)
  await tracker.flushNow(SID)

  const flat = transport.batches.flat()
  const childTraceId = createHash("sha256").update(`opencode-langfuse:trace:${childSession}`, "utf8").digest("hex").slice(0, 32)
  const childRootId = createHash("sha256").update(`opencode-langfuse:root:${childSession}`, "utf8").digest("hex").slice(0, 16)
  const spans = toolSpans(flat)
  assert.equal(spans.length, 1, "the child's own tool call produces exactly one span")
  assert.equal(spans[0].body.id, toolObservationId(childSession, "msg_1", "call_1"))
  assert.equal(spans[0].body.traceId, childTraceId)
  assert.equal(spans[0].body.parentObservationId, childRootId)
  // No parent contamination: no span or observation under the parent session.
  assert.ok(!flat.some((e) => e.body.id === toolObservationId(SID, "msg_1", "call_1")))
  const childTrace = flat.find((e) => e.type === "trace-create" && e.body.id === childTraceId)
  assert.ok(childTrace)
  assert.equal(childTrace.body.name, "opencode-subagent:general")
  assert.equal(childTrace.body.sessionId, SID, "child groups under the direct parent session")
  assert.equal((childTrace.body.metadata as EventInput).parentSessionID, SID)
  assert.equal((childTrace.body.metadata as EventInput).parent_trace_id, createHash("sha256").update(`opencode-langfuse:trace:${SID}`, "utf8").digest("hex").slice(0, 32))
})

test("shutdown marks running tools interrupted under the plugin.shutdown boundary", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  await tracker.shutdown()

  const body = toolSpans(transport.batches.flat()).at(-1)!.body
  assert.equal(body.level, "WARNING")
  assert.equal((body.metadata as EventInput).captureStatus, "interrupted")
  assert.equal((body.metadata as EventInput).endBoundary, "plugin.shutdown")
})

test("callback completion after close creates no records or POSTs", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  await tracker.shutdown()
  const batchesBefore = transport.batches.length

  tracker.handleToolAfter(afterHook({ id: "call_1" }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 1 }))
  await settleTimers()

  assert.equal(transport.batches.length, batchesBefore)
})

test("metadata-only preset exports tool spans with content fields absent", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, {
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
  })
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolCalled({ id: "call_1", seq: 2 }))
  tracker.handleToolAfter(
    afterHook({ id: "call_1", result: { content: [{ type: "text", text: "secret text" }] } }),
  )
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal("input" in body, false)
  assert.equal("output" in body, false)
  assert.equal(body.level, "DEFAULT")
  assert.equal((body.metadata as EventInput).toolCallID, "call_1")
})

test("named shell failure from a durable failed fact keeps scalar score facts available", async () => {
  // Name hint + durable failed: the observation exports ERROR even without a hook.
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(toolInputStarted("shell", { id: "call_1", seq: 1 }))
  tracker.handleEvent(toolFailed({ id: "call_1", seq: 2, message: "native failed" }))
  await tracker.flushNow(SID)

  const body = toolSpans(transport.batches.flat())[0].body
  assert.equal(body.name, "shell")
  assert.equal(body.level, "ERROR")
  assert.equal((body.metadata as EventInput).outcomeSource, "session.tool.failed")
})

test("buildToolEvent update phase omits the parent link and whitelists metadata", () => {
  const record = {
    observationId: "obs_1",
    sessionID: SID,
    assistantMessageID: "msg_1",
    toolCallID: "call_1",
    name: "shell",
    startTime: BASE,
    endTime: BASE + 5,
    captureStatus: "error" as const,
    nativeStatus: "completed" as const,
    outcomeSource: "execute.after" as const,
    exitCode: 7,
    startBoundary: "session.tool.called" as const,
    endBoundary: "execute.after" as const,
  }
  const event = buildToolEvent(record, { traceId: "trace_1", rootObservationId: "root_1" }, "update", "evt_1", BASE, FULL_POLICY)
  assert.equal(event.type, "span-update")
  assert.equal("parentObservationId" in event.body, false)
  const metadata = event.body.metadata as EventInput
  assert.deepEqual(
    Object.keys(metadata).sort(),
    ["assistantMessageID", "captureStatus", "endBoundary", "exitCode", "isError", "kind", "nativeStatus", "outcomeSource", "sessionId", "startBoundary", "toolCallID"],
  )
  assert.equal(metadata.isError, true)
  assert.equal(metadata.exitCode, 7)
  assert.equal(event.body.startTime, new Date(BASE).toISOString())
  assert.equal(event.body.endTime, new Date(BASE + 5).toISOString())
})
