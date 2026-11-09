import assert from "node:assert/strict"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, IngestResult, LangfuseTransport } from "../src/langfuse.js"
import { createTracker } from "../src/tracker.js"

const BASE = 1_700_000_000_000

interface FakeTransport extends LangfuseTransport {
  batches: IngestEvent[][]
}

function fakeTransport(result: IngestResult | "throw" | "ok" = "ok"): FakeTransport {
  const batches: IngestEvent[][] = []
  return {
    batches,
    async ingest(events: IngestEvent[]): Promise<IngestResult> {
      if (result === "throw") {
        throw new Error("network down")
      }
      batches.push(events)
      return typeof result === "string" ? { accepted: events.length, failed: 0 } : result
    },
  }
}

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>
const POLICY = createCapturePolicy({ preset: "conversations", env: FULL_ENV })

function makeTracker(transport: FakeTransport, lookupParentID?: (sessionId: string) => Promise<string | undefined>) {
  let seq = 0
  return createTracker({
    transport,
    policy: POLICY,
    flushDelayMs: 5,
    newId: () => `id-${(seq += 1)}`,
    now: () => BASE + 10_000,
    lookupParentID,
  })
}

function feed(tracker: ReturnType<typeof createTracker>, sessionId: string, opts: { prompt?: string; output?: string } = {}) {
  tracker.handleEvent({ type: "session.created", created: BASE, data: { sessionID: sessionId } })
  if (opts.prompt !== undefined) {
    tracker.handleEvent({
      type: "session.inbox.enqueued",
      created: BASE + 100,
      data: { sessionID: sessionId, item: { type: "user", payload: { text: opts.prompt, files: [] } } },
    })
  }
  if (opts.output !== undefined) {
    tracker.handleEvent({
      type: "session.text.ended",
      created: BASE + 500,
      data: { sessionID: sessionId, text: opts.output },
    })
  }
}

test("flushes one trace with a root observation per primary session", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  feed(tracker, "ses_1", { prompt: "hello world", output: "final answer" })
  tracker.handleEvent({ type: "session.execution.succeeded", created: BASE + 600, data: { sessionID: "ses_1" } })
  await tracker.flushNow("ses_1")

  assert.equal(transport.batches.length, 1)
  const [trace, span] = transport.batches[0]
  assert.equal(trace.type, "trace-create")
  assert.equal(trace.body.name, "opencode-agent")
  assert.equal(trace.body.sessionId, "ses_1")
  assert.equal(trace.body.input, "hello world")
  assert.equal(trace.body.output, "final answer")
  assert.deepEqual(trace.body.metadata, { sessionId: "ses_1", completed: true })

  assert.equal(span.type, "span-create")
  assert.equal(span.body.traceId, trace.body.id)
  assert.equal(span.body.level, "DEFAULT")
  assert.equal(span.body.input, "hello world")
  assert.equal(span.body.output, "final answer")
  assert.match(String(span.body.startTime), /^\d{4}-\d{2}-\d{2}T/)
  assert.match(String(span.body.endTime), /^\d{4}-\d{2}-\d{2}T/)

  assert.deepEqual(tracker.pendingSessionIds(), [])
})

test("skips child sessions entirely", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, async (sessionId) => (sessionId === "ses_child" ? "ses_parent" : undefined))
  tracker.handleEvent({ type: "session.created", created: BASE, data: { sessionID: "ses_child", parentID: "ses_parent" } })
  tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: BASE + 100,
    data: { sessionID: "ses_child", item: { type: "user", payload: { text: "subtask" } } },
  })
  tracker.handleEvent({ type: "session.execution.succeeded", created: BASE + 600, data: { sessionID: "ses_child" } })
  await tracker.flushAll()

  assert.equal(transport.batches.length, 0)
})

test("recovers a missed session.created via the session API lookup", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, async () => undefined)
  await tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: BASE + 100,
    data: { sessionID: "ses_late", item: { type: "user", payload: { text: "first prompt after boot" } } },
  })
  tracker.handleEvent({
    type: "session.text.ended",
    created: BASE + 500,
    data: { sessionID: "ses_late", text: "answer" },
  })
  tracker.handleEvent({ type: "session.execution.succeeded", created: BASE + 600, data: { sessionID: "ses_late" } })
  await tracker.flushNow("ses_late")

  assert.equal(transport.batches.length, 1)
  const [trace] = transport.batches[0]
  assert.equal(trace.body.sessionId, "ses_late")
  assert.equal(trace.body.input, "first prompt after boot")
  assert.equal(trace.body.output, "answer")
})

test("lookup failure fails open and still traces the session", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, async () => {
    throw new Error("api down")
  })
  tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: BASE + 100,
    data: { sessionID: "ses_fail", item: { type: "user", payload: { text: "prompt" } } },
  })
  await tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: BASE + 110,
    data: { sessionID: "ses_fail", item: { type: "user", payload: { text: "prompt" } } },
  })
  assert.deepEqual(tracker.pendingSessionIds(), ["ses_fail"])
})

test("metadata-only preset omits prompt and response", async () => {
  const transport = fakeTransport()
  const tracker = createTracker({
    transport,
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    flushDelayMs: 5,
    now: () => BASE,
  })
  feed(tracker, "ses_2", { prompt: "secret prompt", output: "secret answer" })
  await tracker.flushNow("ses_2")

  const [trace] = transport.batches[0]
  assert.ok(!("input" in trace.body))
  assert.ok(!("output" in trace.body))
  assert.deepEqual(trace.body.metadata, { sessionId: "ses_2", completed: true })
})

test("unknown sessions are ignored", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent({ type: "session.execution.succeeded", created: BASE, data: { sessionID: "ses_unknown" } })
  tracker.handleEvent({ type: "session.text.ended", created: BASE, data: { sessionID: "ses_unknown", text: "x" } })
  await tracker.flushAll()

  assert.equal(transport.batches.length, 0)
})

test("first user prompt wins; later ones are ignored", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  feed(tracker, "ses_3", { prompt: "first prompt", output: "answer" })
  tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: BASE + 700,
    data: { sessionID: "ses_3", item: { type: "user", payload: { text: "steer prompt" } } },
  })
  await tracker.flushNow("ses_3")

  assert.equal(transport.batches[0][0].body.input, "first prompt")
})

test("failed ingestion drops the record without throwing", async () => {
  const transport = fakeTransport({ accepted: 0, failed: 2 })
  const tracker = makeTracker(transport)
  feed(tracker, "ses_4", { prompt: "p", output: "o" })
  await tracker.flushNow("ses_4")

  assert.deepEqual(tracker.pendingSessionIds(), [])
})

test("flushAll flushes every pending session", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  feed(tracker, "ses_a", { prompt: "a", output: "x" })
  feed(tracker, "ses_b", { prompt: "b", output: "y" })
  assert.equal(tracker.pendingSessionIds().length, 2)

  await tracker.flushAll()
  assert.equal(transport.batches.length, 2)
  assert.deepEqual(tracker.pendingSessionIds(), [])
})

test("non-user inbox items and malformed events are ignored", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_x" } })
  tracker.handleEvent({ type: "session.created", data: {} })
  tracker.handleEvent({ type: "session.text.ended", data: { sessionID: "ses_x" } })

  assert.deepEqual(tracker.pendingSessionIds(), [])
  assert.equal(transport.batches.length, 0)
})
