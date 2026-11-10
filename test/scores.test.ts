import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, LangfuseTransport } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver } from "../src/pricing.js"
import { createTracker, type SessionSnapshot, type Tracker, type TrackerOptions } from "../src/tracker.js"
import { computeScores, scoreId, SCORE_NAMES } from "../src/scores.js"

const BASE = 1_700_000_000_000
const SID = "ses_score_a1b2c3d4"

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

function sessionCreated(created = BASE, seq = 0): EventInput {
  return ev("session.created", created, { sessionID: SID }, seq)
}

function inboxPrompt(text: string, seq = 1): EventInput {
  return ev("session.inbox.enqueued", BASE + 100, { sessionID: SID, item: { type: "user", payload: { text } } }, seq)
}

function executionStarted(): EventInput {
  return ev("session.execution.started", BASE + 150, { sessionID: SID }, 4)
}

function executionSucceeded(created = BASE + 400, seq = 9): EventInput {
  return ev("session.execution.succeeded", created, { sessionID: SID }, seq)
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

function toolCalled(seq: number, created: number, id: string, assistantMessageID = "msg_1"): EventInput {
  return ev("session.tool.called", created, { sessionID: SID, assistantMessageID, id, input: { command: "x" }, executed: false }, seq)
}

function toolSuccess(seq: number, created: number, id: string, assistantMessageID = "msg_1"): EventInput {
  return ev("session.tool.success", created, {
    sessionID: SID,
    assistantMessageID,
    id,
    content: [{ type: "text", text: "ok" }],
    metadata: {},
    executed: false,
  }, seq)
}

function toolFailed(seq: number, created: number, id: string, assistantMessageID = "msg_1"): EventInput {
  return ev("session.tool.failed", created, {
    sessionID: SID,
    assistantMessageID,
    id,
    error: { type: "tool.execution", message: "failed" },
    executed: false,
  }, seq)
}

function toolInputStarted(seq: number, created: number, id: string, name: string, assistantMessageID = "msg_1"): EventInput {
  return ev("session.tool.input.started", created, { sessionID: SID, assistantMessageID, id, name }, seq)
}

function compactionStarted(seq: number, created: number): EventInput {
  return ev("session.compaction.started", created, { sessionID: SID, reason: "manual" }, seq)
}

function compactionEnded(seq: number, created: number): EventInput {
  return ev("session.compaction.ended", created, { sessionID: SID, reason: "manual", text: "summary" }, seq)
}

function scoreEvents(events: IngestEvent[]): IngestEvent[] {
  return events.filter((e) => e.type === "score-create")
}

function scoreValues(events: IngestEvent[]): Map<string, { value: unknown; dataType: unknown; traceId: unknown; id: unknown }> {
  return new Map(scoreEvents(events).map((e) => [String(e.body.name), { value: e.body.value, dataType: e.body.dataType, traceId: e.body.traceId, id: e.body.id }]))
}

function omissionWarnings(logs: string[]): string[] {
  return logs.filter((m) => m.includes('Scores omitted for session "') && m.includes(": complete history unavailable"))
}

async function settleTimers(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const expectedTraceId = createHash("sha256").update(`opencode-langfuse:trace:${SID}`, "utf8").digest("hex").slice(0, 32)

test("computeScores matches the fixed sibling semantics", () => {
  const zero = computeScores({ toolCallCount: 0, turnCount: 3, toolErrorCount: 0 })
  assert.deepEqual(zero, { tool_call_count: 0, turn_count: 3, total_tool_errors: 0, tool_success_rate: 1, session_had_errors: 0 })
  const mixed = computeScores({ toolCallCount: 3, turnCount: 5, toolErrorCount: 1 })
  assert.equal(mixed.tool_success_rate, 2 / 3)
  assert.equal(mixed.session_had_errors, 1)
})

test("a plain session publishes all five scores with correct values, types, and stable ids", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("plain question"))
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(executionStarted())
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)

  const events = transport.batches.flat()
  const scores = scoreValues(events)
  assert.equal(scores.size, 5)
  const want: Record<string, number> = { tool_call_count: 0, turn_count: 1, total_tool_errors: 0, tool_success_rate: 1, session_had_errors: 0 }
  for (const [name, expected] of Object.entries(want)) {
    const row = scores.get(name)
    assert.ok(row, `${name} present`)
    assert.equal(row.value, expected, `${name} value`)
    assert.equal(row.dataType, name === "session_had_errors" ? "BOOLEAN" : "NUMERIC", `${name} dataType`)
    assert.equal(row.traceId, expectedTraceId, `${name} trace linkage`)
    assert.equal(row.id, scoreId(SID, name as never), `${name} stable id`)
  }
  assert.equal(SCORE_NAMES.length, 5)
  // Repeat terminals and flushes never create additional score identities.
  tracker.handleEvent(executionSucceeded(BASE + 500, 10))
  await tracker.flushNow(SID)
  tracker.handleEvent(executionSucceeded(BASE + 600, 11))
  await tracker.flushNow(SID)
  const again = scoreValues(transport.batches.flat())
  assert.equal(again.size, 5)
  assert.deepEqual([...again.keys()].sort(), Object.keys(want).sort())
  assert.equal(omissionWarnings(logs).length, 0)
})

test("tool outcomes accumulate once per identity across continued prompts", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  // Prompt 1: two tools, one failure.
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(toolInputStarted(3, BASE + 205, "call_a", "shell"))
  tracker.handleEvent(toolCalled(4, BASE + 210, "call_a"))
  tracker.handleEvent(toolSuccess(5, BASE + 250, "call_a"))
  tracker.handleEvent(toolInputStarted(6, BASE + 205, "call_b", "shell"))
  tracker.handleEvent(toolCalled(7, BASE + 210, "call_b"))
  tracker.handleEvent(toolFailed(8, BASE + 250, "call_b"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)

  let scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 2)
  assert.equal(scores.get("turn_count")?.value, 1)
  assert.equal(scores.get("total_tool_errors")?.value, 1)
  assert.equal(scores.get("tool_success_rate")?.value, 0.5)
  assert.equal(scores.get("session_had_errors")?.value, 1)

  // Continuation: another turn with one more failing tool.
  tracker.handleEvent(stepStarted(20, BASE + 500, "msg_2"))
  tracker.handleEvent(toolCalled(21, BASE + 510, "call_c", "msg_2"))
  tracker.handleEvent(toolFailed(22, BASE + 550, "call_c", "msg_2"))
  tracker.handleEvent(executionSucceeded(BASE + 600, 30))
  await tracker.flushNow(SID)

  scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 3)
  assert.equal(scores.get("turn_count")?.value, 2)
  assert.equal(scores.get("total_tool_errors")?.value, 2)
  const ids = new Set(scoreEvents(transport.batches.flat()).map((e) => e.body.id))
  assert.equal(ids.size, 5, "same five stable ids across revisions")
})

test("duplicate facts, duplicate terminals, and repeated flushes never increment counts", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(toolCalled(3, BASE + 210, "call_a"))
  tracker.handleEvent(toolCalled(4, BASE + 211, "call_a"))
  tracker.handleEvent(toolFailed(5, BASE + 250, "call_a"))
  tracker.handleEvent(toolFailed(6, BASE + 251, "call_a"))
  tracker.handleEvent(executionSucceeded())
  tracker.handleEvent(executionSucceeded(BASE + 500, 10))
  await tracker.flushNow(SID)
  await tracker.flushNow(SID)

  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 1)
  assert.equal(scores.get("total_tool_errors")?.value, 1)
  assert.equal(scores.get("turn_count")?.value, 1)
  assert.equal(scoreEvents(transport.batches.flat()).length, 5)
})

test("auxiliary exchanges add neither turns nor tool outcomes", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(executionSucceeded())
  const response = new Response("{}", { status: 200 })
  tracker.startAuxiliary({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", body: "{}" }),
  })
  tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", body: "{}" }),
    response,
  })
  await tracker.flushNow(SID)
  await settleTimers()

  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("turn_count")?.value, 1)
  assert.equal(scores.get("tool_call_count")?.value, 0)
})

test("a locally observed session.created starts complete at zero counts", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("first"))
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)
  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("turn_count")?.value, 1)
  assert.equal(scores.get("tool_call_count")?.value, 0)
})

test("uncompacted cold restore seeds exact counts from the snapshot without double counting", async () => {
  const transport = fakeTransport()
  const snapshot: SessionSnapshot = {
    createdAt: BASE,
    scoreHistory: {
      complete: true,
      turns: ["msg_1"],
      tools: [{ assistantMessageID: "msg_1", toolCallID: "call_a", name: "shell", status: "error", exit: 7 }],
    },
  }
  const logs: string[] = []
  const tracker = makeTracker(transport, {
    lookupSession: async () => snapshot,
  }, logs)
  // Cold load: the first observed event is a live step event, and the snapshot already includes it.
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)

  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("turn_count")?.value, 1)
  assert.equal(scores.get("tool_call_count")?.value, 1)
  assert.equal(scores.get("total_tool_errors")?.value, 1)
  assert.equal(scores.get("tool_success_rate")?.value, 0)
  assert.equal(scores.get("session_had_errors")?.value, 1)
  assert.equal(omissionWarnings(logs).length, 0)
})

test("a warm ledger is never replaced by a later context read and stays cumulative through compaction", async () => {
  const transport = fakeTransport()
  let snapshot: SessionSnapshot | undefined = { createdAt: BASE, scoreHistory: { complete: true, turns: [], tools: [] } }
  const tracker = makeTracker(transport, { lookupSession: async () => snapshot })
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(toolCalled(3, BASE + 210, "call_a"))
  tracker.handleEvent(toolFailed(4, BASE + 250, "call_a"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)
  let scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("total_tool_errors")?.value, 1)

  // Compaction completes between prompts; the warm ledger is untouched.
  tracker.handleEvent(compactionStarted(40, BASE + 300))
  tracker.handleEvent(compactionEnded(41, BASE + 350))
  // A later context read would report the summary window; the tracker ignores it.
  snapshot = { createdAt: BASE, scoreHistory: { complete: true, turns: [], tools: [] } }
  tracker.handleEvent(stepStarted(50, BASE + 500, "msg_2"))
  tracker.handleEvent(executionSucceeded(BASE + 600, 60))
  await tracker.flushNow(SID)

  scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("turn_count")?.value, 2, "warm totals survive compaction")
  assert.equal(scores.get("tool_call_count")?.value, 1)
  assert.equal(scores.get("total_tool_errors")?.value, 1)
})

test("compacted cold restore omits all five scores with one warning and keeps observations", async () => {
  const transport = fakeTransport()
  const snapshot: SessionSnapshot = {
    createdAt: BASE,
    scoreHistory: { complete: false },
  }
  const logs: string[] = []
  const tracker = makeTracker(transport, { lookupSession: async () => snapshot }, logs)
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(stepEnded(3, BASE + 250, "msg_1"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)

  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
  assert.equal(omissionWarnings(logs).length, 1)
  // Observations/root/cost continue normally.
  assert.ok(transport.batches.flat().some((e) => e.type === "trace-create"))
  assert.ok(transport.batches.flat().some((e) => e.type === "generation-create"))
  // Not-ready scores leave the session clean inactive (no timer spin, no permanent pending).
  assert.deepEqual(tracker.pendingSessionIds(), [])
})

test("a failed snapshot lookup starts incomplete and omits scores", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, { lookupSession: async () => undefined }, logs)
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)
  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
  assert.equal(omissionWarnings(logs).length, 1)
})

test("pending tools delay the snapshot; a late authoritative terminal finishes the same revision", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(toolCalled(3, BASE + 210, "call_a"))
  tracker.handleEvent(executionSucceeded(BASE + 300, 9))
  await tracker.flushNow(SID)
  assert.equal(scoreEvents(transport.batches.flat()).length, 0, "no fabricated success ratio for pending tools")

  // The real terminal arrives after execution completion: same revision becomes ready and dirty.
  tracker.handleEvent(toolFailed(4, BASE + 350, "call_a"))
  await tracker.flushNow(SID)
  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 1)
  assert.equal(scores.get("total_tool_errors")?.value, 1)
  assert.equal(scores.get("tool_success_rate")?.value, 0)
  assert.equal(scores.get("turn_count")?.value, 1)
})

test("interrupted-only tools never publish a fabricated ratio", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(stepStarted(2, BASE + 200, "msg_1"))
  tracker.handleEvent(toolCalled(3, BASE + 210, "call_a"))
  tracker.handleEvent(ev("session.execution.interrupted", BASE + 300, { sessionID: SID, reason: "user" }, 9))
  await tracker.flushNow(SID)
  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
})

test("tool observation capacity refusal does not change score totals", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(sessionCreated())
  // Fill the generation capacity is unrelated; fill the tool capacity with 256 pending calls.
  for (let i = 0; i < 256; i += 1) {
    tracker.handleEvent(toolCalled(i * 3 + 10, BASE + 210 + i, `call_${i}`))
  }
  tracker.handleEvent(toolCalled(900, BASE + 500, "call_overflow"))
  tracker.handleEvent(executionSucceeded(BASE + 600, 901))
  await tracker.flushNow(SID)
  // Pending tools delay the snapshot; refusal must not change what is counted.
  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
  assert.ok(logs.some((m) => m.includes("pending tool capacity reached")))

  for (let i = 0; i < 256; i += 1) {
    tracker.handleEvent(toolSuccess(1000 + i, BASE + 700 + i, `call_${i}`))
  }
  await tracker.flushNow(SID)
  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 256)
  assert.equal(scores.get("total_tool_errors")?.value, 0)
  assert.equal(scores.get("tool_success_rate")?.value, 1)
})

test("ledger overflow suppresses score updates once without unbounded growth", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(sessionCreated())
  for (let i = 0; i < 8193; i += 1) {
    tracker.handleEvent(stepStarted(i + 2, BASE + 200 + i, `msg_${i}`))
  }
  tracker.handleEvent(executionSucceeded(BASE + 9_000, 99_999))
  await tracker.flushNow(SID)

  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
  assert.equal(omissionWarnings(logs).length, 1)
})

test("a malformed snapshot tool fact seeds incomplete rather than inventing a call", async () => {
  const transport = fakeTransport()
  const snapshot: SessionSnapshot = {
    createdAt: BASE,
    scoreHistory: { complete: false },
  }
  const tracker = makeTracker(transport, { lookupSession: async () => snapshot })
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)
  assert.equal(scoreEvents(transport.batches.flat()).length, 0)
})

test("snapshot tools with pending status delay publication until a terminal fact arrives", async () => {
  const transport = fakeTransport()
  const snapshot: SessionSnapshot = {
    createdAt: BASE,
    scoreHistory: {
      complete: true,
      turns: ["msg_1"],
      tools: [{ assistantMessageID: "msg_1", toolCallID: "call_a", name: "shell", status: "running" }],
    },
  }
  const tracker = makeTracker(transport, { lookupSession: async () => snapshot })
  tracker.handleEvent(executionSucceeded())
  await tracker.flushNow(SID)
  assert.equal(scoreEvents(transport.batches.flat()).length, 0, "pending seed tool delays the snapshot")

  tracker.handleEvent(toolSuccess(10, BASE + 300, "call_a"))
  await tracker.flushNow(SID)
  const scores = scoreValues(transport.batches.flat())
  assert.equal(scores.get("tool_call_count")?.value, 1)
  assert.equal(scores.get("tool_success_rate")?.value, 1)
})
