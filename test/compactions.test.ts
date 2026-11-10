import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, LangfuseTransport } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver } from "../src/pricing.js"
import { createTracker, type Tracker, type TrackerOptions } from "../src/tracker.js"
import { buildCompactionEvent, compactionStartId, compactionTerminalId } from "../src/compactions.js"

const BASE = 1_700_000_000_000
const SID = "ses_comp_a1b2c3d4"

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>
const POLICY = createCapturePolicy({ preset: "conversations", env: FULL_ENV })

interface FakeTransport extends LangfuseTransport {
  batches: IngestEvent[][]
}

function fakeTransport(): FakeTransport {
  const batches: IngestEvent[][] = []
  return {
    batches,
    async ingest(events: IngestEvent[]) {
      batches.push(events)
      return { accepted: events.length, failed: 0 }
    },
  }
}

function testPricing(): PricingResolver {
  return createPricingResolver({ loadCatalog: async () => ({ data: [] }), log: () => {} })
}

function makeTracker(transport: FakeTransport, overrides: Partial<TrackerOptions> = {}, logs: string[] = []): Tracker {
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

function ev(type: string, created: number, data: EventInput, seq: number): EventInput {
  return { type, created, durable: { aggregateID: SID, seq, version: 1 }, data }
}

function compactionStarted(
  seq: number,
  created: number,
  opts: { reason?: "auto" | "manual"; inputID?: string; sessionID?: string; omitDurable?: boolean } = {},
): EventInput {
  const data: EventInput = { sessionID: opts.sessionID ?? SID, reason: opts.reason ?? "manual" }
  if (opts.inputID !== undefined) data.inputID = opts.inputID
  const event: EventInput = { type: "session.compaction.started", created, data }
  if (!opts.omitDurable) event.durable = { aggregateID: opts.sessionID ?? SID, seq, version: 1 }
  return event
}

function compactionEnded(
  seq: number,
  created: number,
  opts: { reason?: "auto" | "manual"; sessionID?: string; omitDurable?: boolean } = {},
): EventInput {
  const data: EventInput = {
    sessionID: opts.sessionID ?? SID,
    reason: opts.reason ?? "manual",
    text: "native summary bytes that must never appear",
    tokens: { input: 10, output: 10 },
    cost: 0.5,
  }
  const event: EventInput = { type: "session.compaction.ended", created, data }
  if (!opts.omitDurable) event.durable = { aggregateID: opts.sessionID ?? SID, seq, version: 1 }
  return event
}

function compactionFailed(
  seq: number,
  created: number,
  opts: { reason?: "auto" | "manual"; errorType?: string; inputID?: string; sessionID?: string; omitDurable?: boolean } = {},
): EventInput {
  const data: EventInput = {
    sessionID: opts.sessionID ?? SID,
    reason: opts.reason ?? "manual",
    error: { type: opts.errorType ?? "compaction.failed", message: "native error message that must never appear" },
  }
  if (opts.inputID !== undefined) data.inputID = opts.inputID
  const event: EventInput = { type: "session.compaction.failed", created, data }
  if (!opts.omitDurable) event.durable = { aggregateID: opts.sessionID ?? SID, seq, version: 1 }
  return event
}

function executionSucceeded(created = BASE + 400, seq = 99): EventInput {
  return ev("session.execution.succeeded", created, { sessionID: SID }, seq)
}

function executionInterrupted(created = BASE + 400, seq = 99): EventInput {
  return ev("session.execution.interrupted", created, { sessionID: SID, reason: "user" }, seq)
}

function inboxPrompt(text: string, seq = 1): EventInput {
  return ev("session.inbox.enqueued", BASE + 100, { sessionID: SID, item: { type: "user", payload: { text } } }, seq)
}

function stepStarted(seq: number, created: number, assistantMessageID: string): EventInput {
  return ev("session.step.started", created, {
    sessionID: SID,
    assistantMessageID,
    agent: "build",
    model: { id: "mock-1", providerID: "mock" },
    started: created - 1,
  }, seq)
}

function stepEnded(seq: number, created: number, assistantMessageID: string): EventInput {
  return ev("session.step.ended", created, {
    sessionID: SID,
    assistantMessageID,
    finish: "stop",
    cost: 5,
    tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } },
  }, seq)
}

function compactionSpans(events: IngestEvent[]): IngestEvent[] {
  return events.filter(
    (e) => (e.type === "span-create" || e.type === "span-update") && (e.body.metadata as EventInput)?.kind === "compaction",
  )
}

function generationSpans(events: IngestEvent[]): IngestEvent[] {
  return events.filter((e) => e.type === "generation-create" || e.type === "generation-update")
}

function rootBodies(events: IngestEvent[]): IngestEvent[] {
  return events.filter((e) => (e.type === "span-create" || e.type === "span-update") && (e.body.metadata as EventInput)?.kind === undefined)
}

async function settleTimers(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test("compaction lifecycle ids follow the documented hash convention", () => {
  const start = createHash("sha256")
    .update(`opencode-langfuse:compaction:${SID}:start:7`, "utf8")
    .digest("hex")
    .slice(0, 16)
  const terminal = createHash("sha256")
    .update(`opencode-langfuse:compaction:${SID}:terminal:9`, "utf8")
    .digest("hex")
    .slice(0, 16)
  assert.equal(compactionStartId(SID, 7), start)
  assert.equal(compactionTerminalId(SID, 9), terminal)
})

test("one successful lifecycle span per native compaction identity despite multiple HTTP exchanges", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("fill context"))
  tracker.handleEvent(stepStarted(2, BASE + 150, "msg_1"))
  tracker.handleEvent(stepEnded(3, BASE + 200, "msg_1"))
  tracker.handleEvent(compactionStarted(10, BASE + 300, { reason: "manual" }))
  tracker.handleEvent(compactionStarted(11, BASE + 305, { reason: "auto", sessionID: "ses_other" }))
  tracker.handleEvent(compactionEnded(12, BASE + 350, { reason: "manual" }))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)

  const spans = compactionSpans(transport.batches.flat())
  const creates = spans.filter((e) => e.type === "span-create")
  assert.equal(creates.length, 1, "one span per lifecycle")
  const body = creates[0].body
  assert.equal(body.name, "compaction")
  assert.equal(body.level, "DEFAULT")
  assert.equal(body.startTime, new Date(BASE + 300).toISOString())
  assert.equal(body.endTime, new Date(BASE + 350).toISOString())
  assert.equal((body.metadata as EventInput).reason, "manual")
  assert.equal((body.metadata as EventInput).startBoundary, "session.compaction.started")
  assert.equal((body.metadata as EventInput).endBoundary, "session.compaction.ended")
  assert.equal(body.id, compactionStartId(SID, 10))
  assert.equal(body.parentObservationId, createHash("sha256").update(`opencode-langfuse:root:${SID}`, "utf8").digest("hex").slice(0, 16))
  // No summary/history/bytes and no invented usage/cost in any lifecycle payload.
  const allSpans = JSON.stringify(spans.map((s) => s.body))
  assert.ok(!allSpans.includes("native summary bytes"))
  for (const span of spans) {
    assert.equal("input" in span.body, false)
    assert.equal("output" in span.body, false)
    assert.equal("usageDetails" in span.body, false)
    assert.equal("costDetails" in span.body, false)
  }
})

test("repeated compactions remain distinct spans", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionEnded(11, BASE + 350))
  tracker.handleEvent(compactionStarted(20, BASE + 500))
  tracker.handleEvent(compactionEnded(21, BASE + 550))
  await tracker.flushNow(SID)

  const creates = compactionSpans(transport.batches.flat()).filter((e) => e.type === "span-create")
  assert.equal(creates.length, 2)
  assert.equal(new Set(creates.map((c) => c.body.id)).size, 2)
  assert.equal(creates[0].body.id, compactionStartId(SID, 10))
  assert.equal(creates[1].body.id, compactionStartId(SID, 20))
})

test("a missing start never fabricates its start time", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(compactionEnded(12, BASE + 350))
  await tracker.flushNow(SID)

  const body = compactionSpans(transport.batches.flat()).filter((e) => e.type === "span-create")[0].body
  assert.equal(body.startTime, undefined)
  assert.equal((body.metadata as EventInput).startBoundary, "unavailable")
  assert.equal(body.endTime, new Date(BASE + 350).toISOString())
  assert.equal(body.id, compactionTerminalId(SID, 12))
  assert.equal(body.level, "DEFAULT")
  assert.equal(logs.filter((m) => m.includes("without a matching active start")).length, 1)
})

test("a failed lifecycle closes ERROR with fixed status text and no native error echo", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionFailed(11, BASE + 340, { errorType: "compaction.failed" }))
  await tracker.flushNow(SID)

  const body = compactionSpans(transport.batches.flat()).at(-1)!.body
  assert.equal(body.level, "ERROR")
  assert.equal((body.metadata as EventInput).captureStatus, "error")
  assert.equal(body.statusMessage, "compaction failed")
  const serialized = JSON.stringify(transport.batches.flat().map((e) => e.body))
  assert.ok(!serialized.includes("native error message"))
})

test("a natively interrupted compaction is WARNING, not a successful completion or invented error", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionFailed(11, BASE + 340, { errorType: "compaction.interrupted" }))
  await tracker.flushNow(SID)

  const body = compactionSpans(transport.batches.flat()).at(-1)!.body
  assert.equal(body.level, "WARNING")
  assert.equal((body.metadata as EventInput).captureStatus, "interrupted")
  assert.equal((body.metadata as EventInput).endBoundary, "session.compaction.failed")
  assert.equal(body.statusMessage, "compaction interrupted")
})

test("a new start while a lifecycle is open marks the older one interrupted, never completed", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionStarted(20, BASE + 400))
  tracker.handleEvent(compactionEnded(21, BASE + 450))
  await tracker.flushNow(SID)

  const creates = compactionSpans(transport.batches.flat()).filter((e) => e.type === "span-create")
  assert.equal(creates.length, 2)
  const first = spanById(transport.batches.flat(), compactionStartId(SID, 10)).at(-1)!.body
  assert.equal(first.level, "WARNING")
  assert.equal((first.metadata as EventInput).captureStatus, "interrupted")
  assert.equal((first.metadata as EventInput).endBoundary, "next-compaction.started")
  const second = spanById(transport.batches.flat(), compactionStartId(SID, 20)).at(-1)!.body
  assert.equal(second.level, "DEFAULT")
  assert.equal((second.metadata as EventInput).captureStatus, "completed")

  function spanById(events: IngestEvent[], id: string | unknown): IngestEvent[] {
    return events.filter((e) => e.body.id === id)
  }
})

test("inputID is retained as correlation evidence and mismatches keep the started value", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(compactionStarted(10, BASE + 300, { inputID: "msg_start" }))
  tracker.handleEvent(compactionFailed(11, BASE + 340, { inputID: "msg_other" }))
  tracker.handleEvent(compactionStarted(20, BASE + 500, { inputID: "msg_keep" }))
  tracker.handleEvent(compactionFailed(21, BASE + 540, { inputID: "msg_keep" }))
  await tracker.flushNow(SID)

  const creates = compactionSpans(transport.batches.flat()).filter((e) => e.type === "span-create")
  assert.equal((creates[0].body.metadata as EventInput).inputID, "msg_start")
  assert.equal((creates[1].body.metadata as EventInput).inputID, "msg_keep")
  assert.equal(logs.filter((m) => m.includes("differs from started")).length, 1)
})

test("malformed compaction events fail open with a bounded diagnostic and no spans", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(compactionStarted(10, BASE + 300, { omitDurable: true, reason: "sideways" as unknown as "manual" }))
  tracker.handleEvent(compactionEnded(11, BASE + 350, { omitDurable: true }))
  tracker.handleEvent(compactionFailed(12, BASE + 360, { omitDurable: true }))
  await tracker.flushNow(SID)

  assert.equal(compactionSpans(transport.batches.flat()).length, 0)
  assert.equal(logs.filter((m) => m.includes("malformed session.compaction.")).length, 3)
})

test("terminal after the execution terminal extends the root without rewriting content", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("first prompt"))
  tracker.handleEvent(stepStarted(2, BASE + 150, "msg_1"))
  tracker.handleEvent(stepEnded(3, BASE + 200, "msg_1"))
  tracker.handleEvent(executionSucceeded(BASE + 250, 9))
  await tracker.flushNow(SID)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionEnded(11, BASE + 350))
  await tracker.flushNow(SID)
  await settleTimers()

  const roots = rootBodies(transport.batches.flat())
  const lastRoot = roots.at(-1)!.body
  assert.equal(lastRoot.endTime, new Date(BASE + 350).toISOString(), "root covers the compaction terminal")
  assert.ok(roots.length >= 2, "root re-exported")
})

test("a held POST submits the running snapshot unchanged, then the ordered completion", async () => {
  const batches: IngestEvent[][] = []
  const gated: (() => void)[] = []
  const transport: FakeTransport = {
    batches,
    async ingest(events: IngestEvent[]) {
      batches.push(events)
      await new Promise<void>((resolve) => gated.push(resolve))
      return { accepted: events.length, failed: 0 }
    },
  }
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  const firstFlush = tracker.flushNow(SID)
  await settleTimers()
  tracker.handleEvent(compactionEnded(11, BASE + 350))
  const secondFlush = tracker.flushNow(SID)
  await settleTimers()

  assert.equal(batches.length, 1)
  const held = compactionSpans(batches[0])
  assert.equal(held[0].type, "span-create")
  assert.equal((held[0].body.metadata as EventInput).captureStatus, "running")

  gated[0]()
  await firstFlush
  await settleTimers()
  assert.equal(batches.length, 2)
  const update = compactionSpans(batches[1])
  assert.equal(update[0].type, "span-update")
  assert.equal(update[0].body.id, held[0].body.id)
  assert.equal((update[0].body.metadata as EventInput).captureStatus, "completed")
  gated[1]()
  await secondFlush
})

test("compaction capacity refusal warns once per episode and resets after drain", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  for (let i = 0; i < 256; i += 1) {
    tracker.handleEvent(compactionStarted(i * 2, BASE + 300 + i))
    tracker.handleEvent(compactionEnded(i * 2 + 1, BASE + 300 + i))
  }
  tracker.handleEvent(compactionStarted(1000, BASE + 900))
  await tracker.flushNow(SID)

  assert.equal(logs.filter((m) => m.includes("pending compaction capacity reached")).length, 1)
  tracker.handleEvent(compactionEnded(1001, BASE + 950))
  await tracker.flushNow(SID)
  await tracker.flushNow(SID)
  tracker.handleEvent(compactionStarted(2000, BASE + 1000))
  tracker.handleEvent(compactionEnded(2001, BASE + 1050))
  await tracker.flushNow(SID)

  const ids = compactionSpans(transport.batches.flat()).filter((e) => e.type === "span-create").map((e) => e.body.id)
  assert.ok(ids.includes(compactionStartId(SID, 2000)), "lifecycle after the reset exported")
  assert.ok(!ids.includes(compactionStartId(SID, 1000)), "refused identity never exported")
})

test("execution interruption and shutdown mark running compactions interrupted", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(executionInterrupted(BASE + 320, 99))
  await tracker.flushNow(SID)

  const interrupted = compactionSpans(transport.batches.flat()).at(-1)!.body
  assert.equal(interrupted.level, "WARNING")
  assert.equal((interrupted.metadata as EventInput).endBoundary, "session.execution.interrupted")
  assert.equal(interrupted.statusMessage, "compaction interrupted")

  const transport2 = fakeTransport()
  const tracker2 = makeTracker(transport2)
  tracker2.handleEvent(compactionStarted(10, BASE + 300))
  await tracker2.shutdown()
  const shutdown = compactionSpans(transport2.batches.flat()).at(-1)!.body
  assert.equal((shutdown.metadata as EventInput).endBoundary, "plugin.shutdown")
})

test("an authoritative native terminal is never overwritten by later lifecycle noise", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionEnded(11, BASE + 350))
  // Duplicate ended arrives with a different time: the closed lifecycle is untouched.
  tracker.handleEvent(compactionEnded(12, BASE + 999))
  await tracker.flushNow(SID)

  const bodies = compactionSpans(transport.batches.flat()).map((e) => e.body)
  const lifecycle = bodies.filter((b) => b.id === compactionStartId(SID, 10)).at(-1)!
  assert.equal(lifecycle.endTime, new Date(BASE + 350).toISOString())
  // The unmatched duplicate becomes its own terminal-only span.
  const terminalOnly = bodies.find((b) => b.id === compactionTerminalId(SID, 12))
  assert.ok(terminalOnly, "unmatched duplicate ended exported terminal-only")
  assert.equal(terminalOnly.startTime, undefined)
})

test("buildCompactionEvent update phase omits the parent link and whitelists metadata", () => {
  const record = {
    observationId: compactionStartId(SID, 5),
    sessionID: SID,
    inputID: "msg_in",
    reason: "manual" as const,
    startTime: BASE,
    endTime: BASE + 50,
    captureStatus: "completed" as const,
    startBoundary: "session.compaction.started" as const,
    endBoundary: "session.compaction.ended" as const,
  }
  const event = buildCompactionEvent(record, { traceId: "trace_1", rootObservationId: "root_1" }, "update", "evt", BASE, POLICY)
  assert.equal(event.type, "span-update")
  assert.equal("parentObservationId" in event.body, false)
  assert.deepEqual(Object.keys(event.body.metadata as EventInput).sort(), ["captureStatus", "endBoundary", "inputID", "kind", "reason", "sessionId", "startBoundary"])
  assert.equal(event.body.name, "compaction")
  assert.equal(event.body.level, "DEFAULT")
  assert.equal("input" in event.body, false)
  assert.equal("output" in event.body, false)
})

test("child sessions never gain compaction spans", async () => {
  const transport = fakeTransport()
  const child = "ses_comp_child"
  const tracker = makeTracker(transport, {
    lookupSession: async (sessionID) => (sessionID === child ? { parentID: SID } : undefined),
  })
  tracker.handleEvent(ev("session.created", BASE, { sessionID: child, parentID: SID }, 0))
  tracker.handleEvent(compactionStarted(10, BASE + 300, { sessionID: child }))
  tracker.handleEvent(compactionEnded(11, BASE + 350, { sessionID: child }))
  await tracker.flushNow(child)
  await tracker.flushNow(SID)
  assert.equal(transport.batches.flat().length, 0)
})

test("generationSpans untouched by compaction lifecycle events", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(compactionStarted(10, BASE + 300))
  tracker.handleEvent(compactionEnded(11, BASE + 350))
  await tracker.flushNow(SID)
  assert.equal(generationSpans(transport.batches.flat()).length, 0)
})
