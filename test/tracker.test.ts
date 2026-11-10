import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, IngestResult, LangfuseTransport } from "../src/langfuse.js"
import type { AssistantSnapshot, SessionSnapshot, Tracker, TrackerOptions } from "../src/tracker.js"
import { createTracker } from "../src/tracker.js"

const BASE = 1_700_000_000_000
const SID = "ses_a1b2c3d4e5f6"

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>
const POLICY = createCapturePolicy({ preset: "conversations", env: FULL_ENV })

function expectedTraceId(sessionID: string): string {
  return createHash("sha256").update(`opencode-langfuse:trace:${sessionID}`, "utf8").digest("hex").slice(0, 32)
}
function expectedRootId(sessionID: string): string {
  return createHash("sha256").update(`opencode-langfuse:root:${sessionID}`, "utf8").digest("hex").slice(0, 16)
}
function expectedGenerationId(sessionID: string, assistantMessageID: string): string {
  return createHash("sha256")
    .update(`opencode-langfuse:generation:${sessionID}:${assistantMessageID}`, "utf8")
    .digest("hex")
    .slice(0, 16)
}

interface FakeTransport extends LangfuseTransport {
  batches: IngestEvent[][]
  ingestCalls: number
  options: (IngestOptions0 | undefined)[]
}

type IngestOptions0 = { signal?: AbortSignal }

function fakeTransport(result: IngestResult | "throw" | "ok" = "ok"): FakeTransport {
  const batches: IngestEvent[][] = []
  const options: (IngestOptions0 | undefined)[] = []
  let ingestCalls = 0
  return {
    batches,
    options,
    get ingestCalls() {
      return ingestCalls
    },
    async ingest(events: IngestEvent[], ingestOptions?: IngestOptions0): Promise<IngestResult> {
      ingestCalls += 1
      options.push(ingestOptions)
      if (result === "throw") {
        throw new Error("network down")
      }
      batches.push(events)
      return typeof result === "string" ? { accepted: events.length, failed: 0 } : result
    },
  }
}

interface LogSpy {
  messages: string[]
}

function makeTracker(
  transport: FakeTransport,
  overrides: Partial<TrackerOptions> = {},
  logSpy?: LogSpy,
): Tracker {
  let seq = 0
  return createTracker({
    transport,
    policy: POLICY,
    flushDelayMs: 5,
    newId: () => `id-${(seq += 1)}`,
    now: () => BASE + 10_000,
    log: (message: string) => logSpy?.messages.push(message),
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

function sessionCreated(created = BASE, sessionID = SID): EventInput {
  return ev("session.created", created, { sessionID, ...{} }, 0)
}

function inboxPrompt(text: string, created = BASE + 100, seq = 1): EventInput {
  return ev("session.inbox.enqueued", created, { sessionID: SID, item: { type: "user", payload: { text, files: [] } } }, seq)
}

function stepStarted(
  assistantMessageID: string,
  opts: { model?: string; providerID?: string; agent?: string; started?: number; created?: number; seq?: number } = {},
): EventInput {
  return ev(
    "session.step.started",
    opts.created ?? BASE + 200,
    {
      sessionID: SID,
      assistantMessageID,
      agent: opts.agent ?? "build",
      model: { id: opts.model ?? "mock-1", providerID: opts.providerID ?? "mock" },
      started: opts.started ?? BASE + 199,
    },
    opts.seq,
  )
}

function stepStreamed(assistantMessageID: string, created: number, seq?: number): EventInput {
  return ev("session.step.streamed", created, { sessionID: SID, assistantMessageID }, seq)
}

function stepEnded(assistantMessageID: string, finish: string, created: number, seq?: number): EventInput {
  return ev("session.step.ended", created, { sessionID: SID, assistantMessageID, finish, cost: 5, tokens: { input: 9 } }, seq)
}

function stepFailed(assistantMessageID: string, message: string, created: number, seq?: number): EventInput {
  return ev(
    "session.step.failed",
    created,
    { sessionID: SID, assistantMessageID, error: { type: "provider", message }, cost: 3, tokens: { input: 2 } },
    seq,
  )
}

function textEnded(text: string, created = BASE + 300, seq = 5): EventInput {
  return ev("session.text.ended", created, { sessionID: SID, text, assistantMessageID: "msg_x" }, seq)
}

function executionSucceeded(created = BASE + 400, seq = 9): EventInput {
  return ev("session.execution.succeeded", created, { sessionID: SID }, seq)
}

function generationsOf(events: IngestEvent[]): IngestEvent[] {
  return events.filter((e) => e.type === "generation-create" || e.type === "generation-update")
}

function metaOf(event: IngestEvent): Record<string, unknown> {
  return (event.body.metadata ?? {}) as Record<string, unknown>
}

/** Runs pending mock-timer callbacks and lets their promise chains settle. */
async function settleTimers(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function flatten(transport: FakeTransport): IngestEvent[] {
  return transport.batches.flat()
}

function makeResponse(body: BodyInit | null, status = 200): Response {
  return new Response(body, { status, statusText: status === 200 ? "OK" : "Status" })
}

async function drainPromise(p: Promise<void>): Promise<{ settled: boolean; error?: unknown }> {
  try {
    await p
    return { settled: true }
  } catch (error) {
    return { settled: false, error }
  }
}

test("two primary steps plus auxiliary exchanges produce exactly two primary and tagged auxiliary generations", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  const titleRequest = new Request("http://mock/title")
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("plan the thing"))
  tracker.handleEvent(stepStarted("msg_a", { seq: 2 }))
  tracker.handleEvent(stepStreamed("msg_a", BASE + 210, 3))
  tracker.handleEvent(stepEnded("msg_a", "tool-calls", BASE + 220, 4))
  tracker.handleEvent(stepStarted("msg_b", { model: "mock-2", started: BASE + 250, created: BASE + 251, seq: 5 }))
  tracker.handleEvent(textEnded("final answer", BASE + 260, 6))
  tracker.handleEvent(stepStreamed("msg_b", BASE + 261, 7))
  tracker.handleEvent(stepEnded("msg_b", "stop", BASE + 262, 8))
  tracker.handleEvent(executionSucceeded(BASE + 300, 9))
  // Interleaved auxiliary exchanges (title overlaps primary work).
  tracker.startAuxiliary({
    sessionID: SID,
    agent: "title",
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: titleRequest,
  })
  tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: titleRequest,
    response: makeResponse("title text"),
  })
  // Extra primary HTTP traffic creates nothing; a duplicate durable start is suppressed.
  tracker.handleEvent(stepStarted("msg_a", { seq: 2 }))
  await tracker.flushAll()

  const events = flatten(transport)
  const primaries = generationsOf(events).filter((e) => e.body.name === "llm-generation")
  assert.equal(primaries.length, 2)
  const aux = generationsOf(events).filter((e) => e.body.name === "llm-generation:title")
  assert.equal(aux.length, 1)

  const trace = events.find((e) => e.type === "trace-create")
  assert.ok(trace)
  assert.equal(trace.body.id, expectedTraceId(SID))
  const span = events.find((e) => e.type === "span-create")
  assert.ok(span)
  assert.equal(span.body.id, expectedRootId(SID))

  const [genA, genB] = primaries
  assert.equal(genA.type, "generation-create")
  assert.equal(genA.body.id, expectedGenerationId(SID, "msg_a"))
  assert.equal(genA.body.model, "mock-1")
  assert.equal(genA.body.parentObservationId, expectedRootId(SID))
  assert.equal(genA.body.traceId, expectedTraceId(SID))
  assert.deepEqual(metaOf(genA).assistantMessageID, "msg_a")
  assert.equal(metaOf(genA).kind, "primary")

  assert.equal(genB.body.id, expectedGenerationId(SID, "msg_b"))
  assert.equal(genB.body.model, "mock-2", "model switch changes only the later generation")
  assert.equal(metaOf(genB).finishReason, "stop")

  assert.equal(metaOf(aux[0]).kind, "title")
  assert.equal(aux[0].body.traceId, expectedTraceId(SID))
  assert.equal(aux[0].body.parentObservationId, expectedRootId(SID))
  assert.equal(metaOf(aux[0]).providerID, "mock")
  assert.equal(metaOf(aux[0]).agent, "title")
  assert.ok(!("assistantMessageID" in metaOf(aux[0])))
})

test("primary endTime is the stream boundary even when tool settlement lags", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_s", { seq: 2 }))
  // Stream terminates long before the step settles (tool ran in between).
  tracker.handleEvent(stepStreamed("msg_s", BASE + 500, 3))
  tracker.handleEvent(stepEnded("msg_s", "tool-calls", BASE + 5_000, 4))
  tracker.handleEvent(executionSucceeded(BASE + 6_000, 5))
  await tracker.flushAll()

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(gen.body.endTime, new Date(BASE + 500).toISOString())
  assert.equal(metaOf(gen).endBoundary, "session.step.streamed")
  assert.equal(metaOf(gen).finishReason, "tool-calls")
})

test("step.failed produces an error generation with redacted safe text and no host cost/tokens", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_f", { seq: 2 }))
  tracker.handleEvent(stepFailed("msg_f", "provider said SECRET_TOKEN=supersecretvalue", BASE + 700, 3))
  tracker.handleEvent(executionSucceeded(BASE + 800, 4))
  await tracker.flushAll()

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(gen.type, "generation-create")
  assert.equal(gen.body.level, "ERROR")
  assert.equal(gen.body.statusMessage, "provider said SECRET_TOKEN=[REDACTED_SECRET]")
  const wire = JSON.stringify(gen)
  assert.ok(!wire.includes("supersecretvalue"))
  assert.ok(!wire.includes("cost"))
  assert.ok(!wire.includes("tokens"))
  assert.ok(!("input" in gen.body))
  assert.ok(!("output" in gen.body))
})

test("events arriving while the cold-load lookup is pending are all retained", async () => {
  const transport = fakeTransport()
  const gate = Promise.withResolvers<void>()
  const tracker = makeTracker(transport, {
    lookupSession: async () => {
      await gate.promise
      return { createdAt: BASE - 50, firstPrompt: "recovered first prompt", latestAssistantOutput: "recovered output" }
    },
  })
  const pending = [
    tracker.handleEvent(inboxPrompt("live prompt")),
    tracker.handleEvent(stepStarted("msg_c", { seq: 2 })),
    tracker.handleEvent(textEnded("streamed answer", BASE + 300, 3)),
    tracker.handleEvent(stepStreamed("msg_c", BASE + 310, 4)),
    tracker.handleEvent(stepEnded("msg_c", "stop", BASE + 320, 5)),
    tracker.handleEvent(executionSucceeded(BASE + 400, 6)),
  ]
  gate.resolve()
  await Promise.all(pending)
  await tracker.flushNow(SID)

  const events = flatten(transport)
  const trace = events.find((e) => e.type === "trace-create")
  assert.ok(trace, "no prompt/output/generation disappears")
  assert.equal(trace.body.input, "recovered first prompt")
  assert.equal(trace.body.output, "streamed answer")
  const gens = generationsOf(events)
  assert.equal(gens.length, 1)
  assert.equal(gens[0].body.id, expectedGenerationId(SID, "msg_c"))
  assert.equal(gens[0].body.startTime, new Date(BASE + 199).toISOString())
  assert.equal(pendingSessionClean(tracker), true)
})

function pendingSessionClean(tracker: Tracker): boolean {
  return tracker.pendingSessionIds().length === 0
}

test("a missing primary start is recovered from the matching transcript assistant", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, {
    lookupAssistant: async (_sessionID, assistantMessageID): Promise<AssistantSnapshot | undefined> =>
      assistantMessageID === "msg_lost"
        ? {
            id: "msg_lost",
            agent: "build",
            model: { id: "mock-2", providerID: "mock" },
            createdAt: BASE + 50,
            streamedAt: BASE + 90,
          }
        : undefined,
  })
  tracker.handleEvent(inboxPrompt("p"))
  // step.started was missed; only the terminal arrives.
  tracker.handleEvent(stepEnded("msg_lost", "stop", BASE + 120, 2))
  tracker.handleEvent(executionSucceeded(BASE + 200, 3))
  await tracker.flushNow(SID)

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(gen.body.id, expectedGenerationId(SID, "msg_lost"))
  assert.equal(gen.body.model, "mock-2", "recovered model comes from the matching transcript, not a default")
  assert.equal(gen.body.startTime, new Date(BASE + 50).toISOString())
  assert.equal(gen.body.endTime, new Date(BASE + 90).toISOString())
  assert.equal(metaOf(gen).endBoundary, "assistant.time.streamed")
})

test("a missing start with no transcript yields an unavailable generation without invented fields", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(transport, { lookupAssistant: async () => undefined }, logs)
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepEnded("msg_ghost", "stop", BASE + 120, 2))
  await tracker.flushNow(SID)

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(metaOf(gen).captureStatus, "unavailable")
  assert.ok(!("model" in gen.body))
  assert.ok(!("startTime" in gen.body))
  assert.equal(gen.body.level, "WARNING")
  assert.ok(logs.messages.some((m) => m.includes("msg_ghost")))
})

test("late auxiliary terminal exports under its own timer and extends a terminal root", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("first prompt"))
  tracker.handleEvent(executionSucceeded(BASE + 200, 2))
  await tracker.flushNow(SID)
  assert.equal(transport.batches.length, 1)
  const spanCreate = transport.batches[0].find((e) => e.type === "span-create")
  assert.ok(spanCreate)
  assert.equal(spanCreate.body.endTime, new Date(BASE + 200).toISOString())

  const request = new Request("http://mock/title-late")
  tracker.startAuxiliary({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request,
  })
  await tracker.flushNow(SID)
  assert.equal(transport.batches.length, 2)
  const create = transport.batches[1].find((e) => e.type === "generation-create")
  assert.ok(create)
  assert.equal(metaOf(create).captureStatus, "running")
  const observationId = create.body.id as string

  const response = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request,
    response: makeResponse("late title"),
  })
  await response.text() // terminal boundary fires without any session event
  t.mock.timers.tick(10) // advance only the auxiliary's own grace timer
  await settleTimers()
  assert.equal(transport.batches.length, 3)
  const batch = transport.batches[2]
  const update = batch.find((e) => e.type === "generation-update")
  assert.ok(update, "terminal update exports without another session event")
  assert.equal(update.body.id, observationId)
  assert.equal(metaOf(update).captureStatus, "completed")
  assert.equal(update.body.level, "DEFAULT")
  const spanUpdate = batch.find((e) => e.type === "span-update")
  assert.ok(spanUpdate, "root end extends monotonically after a terminal root")
  assert.equal(spanUpdate.body.id, expectedRootId(SID))
  assert.equal(spanUpdate.body.traceId, expectedTraceId(SID))
  assert.equal(spanCreate.body.id, spanUpdate.body.id)
  assert.equal(create.body.traceId, expectedTraceId(SID))
})

test("a continued session in a fresh tracker reuses trace identity and the original prompt", async () => {
  const transport = fakeTransport()
  const snapshot: SessionSnapshot = { createdAt: BASE, firstPrompt: "first prompt", latestAssistantOutput: "first answer" }
  const first = makeTracker(transport)
  first.handleEvent(inboxPrompt("first prompt"))
  first.handleEvent(executionSucceeded(BASE + 200, 2))
  await first.flushNow(SID)

  const transportB = fakeTransport()
  const second = makeTracker(transportB, { lookupSession: async () => snapshot })
  second.handleEvent(inboxPrompt("second prompt", BASE + 5_000, 10))
  second.handleEvent(stepStarted("msg_2nd", { created: BASE + 5_100, seq: 11 }))
  second.handleEvent(stepEnded("msg_2nd", "stop", BASE + 5_200, 12))
  second.handleEvent(executionSucceeded(BASE + 5_300, 13))
  await second.flushNow(SID)

  const traceB = flatten(transportB).find((e) => e.type === "trace-create")
  assert.ok(traceB)
  assert.equal(traceB.body.id, expectedTraceId(SID), "same stable identity in a fresh tracker")
  assert.equal(traceB.body.input, "first prompt", "original first prompt survives reconstruction")
  const spanB = flatten(transportB).find((e) => e.type === "span-create")
  assert.equal(spanB?.body.id, expectedRootId(SID))
  assert.equal(spanB?.body.startTime, new Date(BASE).toISOString(), "snapshot supplies the original start")
})

test("an auxiliary terminal during an unresolved export survives and follows its create", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("p"))
  await tracker.flushNow(SID) // root exported

  // Hold all further ingestion in flight, put the auxiliary create on the
  // wire, and let the terminal fire while that create POST is unresolved.
  const release = Promise.withResolvers<void>()
  const originalIngest = transport.ingest.bind(transport)
  transport.ingest = async (events, options) => {
    await release.promise
    return originalIngest(events, options)
  }
  const request = new Request("http://mock/gen")
  tracker.startAuxiliary({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request,
  })
  const createFlush = tracker.flushNow(SID) // aux task runs; create builds and its POST hangs (held)
  await new Promise<void>((resolve) => setImmediate(resolve)) // create is now on the wire, detached from dirty state
  const response = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request,
    response: makeResponse("generated text"),
  })
  const consumed = response.text() // terminal callback fires while the create POST is in flight
  await new Promise<void>((resolve) => setImmediate(resolve)) // let the terminal apply
  const updateFlush = tracker.flushNow(SID) // queues the update behind the in-flight create
  release.resolve()
  await Promise.all([createFlush, updateFlush, consumed])

  const gens = generationsOf(flatten(transport)).filter((e) => e.body.name === "llm-generation:generate")
  const creates = gens.filter((e) => e.type === "generation-create")
  const updates = gens.filter((e) => e.type === "generation-update")
  assert.equal(creates.length, 1)
  assert.equal(updates.length, 1, "the terminal update survives the in-flight create")
  assert.equal(updates[0].body.id, creates[0].body.id)
  const createIndex = flatten(transport).indexOf(creates[0])
  const updateIndex = flatten(transport).indexOf(updates[0])
  assert.ok(updateIndex > createIndex, "update follows its create")
})

test("a failing transport neither rejects the event path nor retries forever", async () => {
  const transport = fakeTransport("throw")
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(executionSucceeded(BASE + 200, 2))
  const outcome = await drainPromise(tracker.flushNow(SID))
  assert.equal(outcome.settled, true, "flush resolves despite transport failure")
  assert.equal(transport.ingestCalls, 1, "one batch, no infinite retries")
  await tracker.flushNow(SID)
  assert.equal(transport.ingestCalls, 1, "dirty state was detached before posting")
})

test("same-kind auxiliary requests pair by Request identity under reverse-order completion", async () => {
  const transport = fakeTransport()
  let tick = 0
  const tracker = makeTracker(transport, { now: () => BASE + (tick += 100) })
  tracker.handleEvent(sessionCreated())
  const requestA = new Request("http://mock/gen-a")
  const requestB = new Request("http://mock/gen-b")
  tracker.startAuxiliary({ sessionID: SID, model: { id: "mock-1", providerID: "mock" }, kind: "generate", request: requestA })
  tracker.startAuxiliary({ sessionID: SID, model: { id: "mock-1", providerID: "mock" }, kind: "generate", request: requestB })
  const responseA = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request: requestA,
    response: makeResponse("a", 201),
  })
  const responseB = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request: requestB,
    response: makeResponse("b", 202),
  })
  const doneB = responseB.text() // short exchange completes first
  const doneA = responseA.text()
  await Promise.all([doneA, doneB])
  await tracker.flushAll()

  const gens = generationsOf(flatten(transport)).filter((e) => e.type === "generation-create")
  assert.equal(gens.length, 2)
  const ids = gens.map((e) => e.body.id)
  assert.notEqual(ids[0], ids[1], "each exchange keeps its own observation ID")
  const statuses = gens.map((e) => metaOf(e).httpStatus).sort()
  assert.deepEqual(statuses, [201, 202], "responses attach to their own request, not by FIFO")
  const starts = gens.map((e) => e.body.startTime)
  assert.notEqual(starts[0], starts[1], "each retains its own dispatch time")
  const ends = gens.map((e) => e.body.endTime)
  assert.notEqual(ends[0], ends[1], "each retains its own terminal time")
})

test("unmatched responses return unchanged and excluded children produce no generations", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(
    transport,
    { lookupSession: async (id) => (id === SID ? undefined : { parentID: "ses_parent" }) },
    logs,
  )
  const stranger = makeResponse(null)
  const returned = tracker.observeAuxiliaryResponse({
    sessionID: "ses_stranger",
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: new Request("http://mock/unknown"),
    response: stranger,
  })
  assert.equal(returned, stranger, "unmatched response is returned unchanged")
  assert.ok(logs.messages.some((m) => m.includes("unmatched")))

  tracker.handleEvent(ev("session.created", BASE, { sessionID: "ses_child", parentID: "ses_parent" }, 0))
  tracker.startAuxiliary({
    sessionID: "ses_child",
    model: { id: "mock-1", providerID: "mock" },
    kind: "title",
    request: new Request("http://mock/child"),
  })
  await tracker.flushAll()
  assert.equal(transport.batches.length, 0, "children produce no trace or generations")
  assert.equal(pendingSessionClean(tracker) || tracker.pendingSessionIds().every((id) => id === SID), true)
})

test("metadata-only preset exports no provider text and still redacts metadata strings", async () => {
  const transport = fakeTransport()
  const tracker = createTracker({
    transport,
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    flushDelayMs: 5,
    newId: () => `id-${Math.random()}`,
    now: () => BASE,
  })
  tracker.handleEvent(inboxPrompt("prompt carrying sk-lf-tokensecretvalue"))
  tracker.handleEvent(stepStarted("msg_m", { seq: 2 }))
  tracker.handleEvent(textEnded("response carrying sk-lf-outputsecretvalue", BASE + 300, 3))
  tracker.handleEvent(stepEnded("msg_m", "stop", BASE + 310, 4))
  tracker.handleEvent(executionSucceeded(BASE + 400, 5))
  await tracker.flushAll()

  const wire = JSON.stringify(transport.batches)
  assert.ok(!wire.includes("tokensecretvalue"))
  assert.ok(!wire.includes("outputsecretvalue"))
  for (const gen of generationsOf(flatten(transport))) {
    assert.ok(!("input" in gen.body))
    assert.ok(!("output" in gen.body))
  }
  const trace = flatten(transport).find((e) => e.type === "trace-create")
  assert.ok(trace)
  assert.ok(!("input" in trace.body))
  assert.ok(!("output" in trace.body))
  assert.equal(metaOf(trace).sessionId, SID)
})

test("generation capacity overflow refuses telemetry only and resets after export", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(sessionCreated())
  const responses: Response[] = []
  for (let i = 0; i < 257; i += 1) {
    const request = new Request(`http://mock/gen-${i}`)
    tracker.startAuxiliary({ sessionID: SID, model: { id: "mock-1", providerID: "mock" }, kind: "generate", request })
    const response = tracker.observeAuxiliaryResponse({
      sessionID: SID,
      model: { id: "mock-1", providerID: "mock" },
      kind: "generate",
      request,
      response: makeResponse(`body-${i}`),
    })
    responses.push(response)
  }
  await Promise.all(responses.map((r) => r.text()))
  await new Promise<void>((resolve) => setImmediate(resolve)) // state chain progresses on a macrotask
  t.mock.timers.tick(10)
  await settleTimers()

  const gens = generationsOf(flatten(transport)).filter((e) => e.body.name === "llm-generation:generate")
  assert.equal(gens.length, 256, "capacity bound holds: the 257th exchange is refused")
  const warnings = logs.messages.filter((m) => m.includes("pending generation capacity"))
  assert.equal(warnings.length, 1, "warns once per capacity episode")

  // Settled generations exported → capacity available again.
  const extraRequest = new Request("http://mock/gen-extra")
  tracker.startAuxiliary({ sessionID: SID, model: { id: "mock-1", providerID: "mock" }, kind: "generate", request: extraRequest })
  const extraResponse = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request: extraRequest,
    response: makeResponse("extra"),
  })
  await extraResponse.text()
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(10)
  await settleTimers()
  const afterReset = generationsOf(flatten(transport)).filter((e) => e.body.name === "llm-generation:generate")
  assert.equal(afterReset.length, 257, "admission resumes when capacity is available")
})

test("session capacity overflow warns once and refuses admission without export loss", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(transport, {}, logs)
  const pending: Promise<void>[] = []
  for (let i = 0; i < 256; i += 1) {
    pending.push(
      tracker.handleEvent(
        ev("session.inbox.enqueued", BASE + i, { sessionID: `ses_full_${i}`, item: { type: "user", payload: { text: `p${i}` } } }, 1),
      ),
    )
  }
  pending.push(
    tracker.handleEvent(
      ev("session.inbox.enqueued", BASE + 999, { sessionID: "ses_over", item: { type: "user", payload: { text: "over" } } }, 1),
    ),
  )
  await Promise.all(pending)
  const ids = tracker.pendingSessionIds()
  assert.equal(ids.length, 256)
  assert.ok(!ids.includes("ses_over"))
  assert.equal(logs.messages.filter((m) => m.includes("tracked session capacity")).length, 1)
})

test("shutdown marks running work interrupted, aborts ingestion, and disables later exports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const seenSignals: (AbortSignal | undefined)[] = []
  let ingestCalls = 0
  const seenBatches: IngestEvent[][] = []
  const transport: LangfuseTransport = {
    async ingest(events, options) {
      ingestCalls += 1
      seenSignals.push(options?.signal)
      seenBatches.push(events)
      return new Promise((resolve) => {
        const settle = () => resolve({ accepted: 0, failed: events.length })
        if (options?.signal?.aborted) {
          settle()
          return
        }
        options?.signal?.addEventListener("abort", settle)
      })
    },
  }
  const tracker = createTracker({
    transport,
    policy: POLICY,
    flushDelayMs: 5,
    newId: () => `id-${Math.random()}`,
    now: () => BASE,
  })
  tracker.handleEvent(sessionCreated())
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_stuck", { seq: 2 }))
  const request = new Request("http://mock/stuck")
  tracker.startAuxiliary({ sessionID: SID, model: { id: "mock-1", providerID: "mock" }, kind: "generate", request })
  const response = tracker.observeAuxiliaryResponse({
    sessionID: SID,
    model: { id: "mock-1", providerID: "mock" },
    kind: "generate",
    request,
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
          // never closes: stuck provider stream
        },
      }),
      { status: 200 },
    ),
  })
  const reader = response.body!.getReader()

  const shutdown = tracker.shutdown()
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)) // let the drain start; ingestion hangs on the abort signal
  t.mock.timers.tick(5_000)
  await shutdown
  assert.equal(ingestCalls > 0, true, "shutdown drains dirty batches")
  const batchWire = JSON.stringify(seenBatches)
  assert.ok(batchWire.includes("interrupted"), "unfinished observations are marked interrupted")

  // No later callback exports: terminal after shutdown must not POST again.
  const callsAtShutdown = ingestCalls
  const chunk = await reader.read()
  assert.equal(new TextDecoder().decode(chunk.value), "partial", "provider reader is not cancelled by shutdown")
  await reader.cancel("consumer done")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(ingestCalls, callsAtShutdown, "no exports after shutdown")

  // Post-shutdown event admission is disabled.
  await tracker.handleEvent(inboxPrompt("after shutdown"))
  await tracker.flushAll()
  assert.equal(ingestCalls, callsAtShutdown)
})
