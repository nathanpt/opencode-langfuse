import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, IngestResult, LangfuseTransport } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver, type PricingOverrides } from "../src/pricing.js"
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

/** Fresh real resolver per fixture: empty overrides/catalog — unpriced models. */
function testPricing(overrides?: PricingOverrides, logs?: string[]): PricingResolver {
  return createPricingResolver({
    ...(overrides ? { overrides } : {}),
    loadCatalog: async () => ({ data: [] }),
    ...(logs ? { log: (message: string) => logs.push(message) } : { log: () => {} }),
  })
}

const OVERRIDE_PRICE = { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.25 }

function near(actual: number | undefined, expected: number, message?: string): void {
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9)
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be ≈ ${expected}`,
  )
}

function omissionWarnings(logs: string[]): string[] {
  return logs.filter((m) => m.includes("Cost omitted for model"))
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
    pricing: testPricing(),
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
  return ev(
    "session.step.ended",
    created,
    {
      sessionID: SID,
      assistantMessageID,
      finish,
      cost: 5,
      tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } },
    },
    seq,
  )
}

function stepFailed(assistantMessageID: string, message: string, created: number, seq?: number): EventInput {
  return ev(
    "session.step.failed",
    created,
    {
      sessionID: SID,
      assistantMessageID,
      error: { type: "provider", message },
      cost: 3,
      tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 1, write: 0 } },
    },
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

test("provider error status text is the fixed explanation while output capture is off", async () => {
  const transport = fakeTransport()
  const tracker = createTracker({
    transport,
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    pricing: testPricing(),
    flushDelayMs: 5,
    newId: () => "id-fixed",
    now: () => BASE + 10_000,
    log: () => {},
  })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_g", { seq: 2 }))
  tracker.handleEvent(stepFailed("msg_g", "provider said SECRET_TOKEN=supersecretvalue", BASE + 700, 3))
  tracker.handleEvent(executionSucceeded(BASE + 800, 4))
  await tracker.flushAll()

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(gen.body.level, "ERROR", "classification is unchanged by the gating")
  assert.equal(gen.body.statusMessage, "provider stream failed")
  const wire = JSON.stringify(gen)
  assert.ok(!wire.includes("provider said"), "raw provider message never exported")
  assert.ok(!wire.includes("supersecretvalue"))
  // Numeric usage stays available under metadata-only.
  const usage = gen.body.usageDetails as Record<string, number>
  assert.equal(usage.input, 4)
})

test("step.failed keeps ERROR, computes partial cost independently, and records host cost as metadata only", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(
    transport,
    { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }, logs) },
    { messages: logs },
  )
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
  assert.equal(metaOf(gen).hostCost, 3, "host cost is diagnostic metadata, not arithmetic")
  const usage = gen.body.usageDetails as Record<string, number>
  assert.deepEqual(usage, { input: 4, output: 0, total: 5, cacheRead: 1 }, "partial usage from the failure event")
  assert.ok(!("input" in gen.body))
  assert.ok(!("output" in gen.body))
  const cost = gen.body.costDetails as Record<string, number>
  assert.ok(cost, "partial usage still gets partial computed cost")
  near(cost.input, 4 * 1.5 / 1_000_000)
  near(cost.output, 0)
  near(cost.cacheRead, 1 * 0.15 / 1_000_000)
  near(cost.total, (4 * 1.5 + 1 * 0.15) / 1_000_000)
  assert.ok(!("reasoning" in cost), "zero reasoning usage emits no reasoning cost")
  assert.equal(metaOf(gen).pricingSource, "config")
  assert.equal(omissionWarnings(logs).length, 0)
})

test("primary generations carry usageDetails matching the durable step tokens", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport)
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_u", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_u", "stop", BASE + 300, 3))
  tracker.handleEvent(executionSucceeded(BASE + 400, 4))
  await tracker.flushAll()

  const events = flatten(transport)
  const gen = generationsOf(events).find((e) => e.body.name === "llm-generation")
  assert.ok(gen)
  assert.deepEqual(
    gen.body.usageDetails,
    { input: 37, output: 5, total: 49, reasoning: 2, cacheRead: 5 },
    "zeros omitted; total sums the normalized parts; usage comes from session.step.ended",
  )
  const aux = generationsOf(events).filter((e) => e.body.name !== "llm-generation")
  for (const a of aux) {
    assert.ok(!("usageDetails" in a.body), "auxiliary generations carry no guessed usage")
    assert.ok(!("costDetails" in a.body), "auxiliary generations carry no guessed cost")
    assert.ok(!("pricingSource" in metaOf(a)), "auxiliaries never resolve prices")
  }
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

test("unmatched responses return unchanged and child auxiliaries attribute to the child trace", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(
    transport,
    { lookupSession: async (id) => (id === SID ? undefined : { parentID: "ses_parent", agent: "general" }) },
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
  const flat = flatten(transport)
  const childTrace = flat.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId("ses_child"))
  assert.ok(childTrace, "children export their own trace")
  assert.equal(childTrace.body.name, "opencode-subagent:general")
  assert.equal(childTrace.body.sessionId, "ses_parent", "child groups under the direct parent session")
  assert.equal(metaOf(childTrace).role, "subagent")
  assert.equal(metaOf(childTrace).parentSessionID, "ses_parent")
  assert.equal(metaOf(childTrace).parent_trace_id, expectedTraceId("ses_parent"))
  const childGen = flat.find((e) => e.type.startsWith("generation-") && e.body.traceId === expectedTraceId("ses_child"))
  assert.ok(childGen, "child auxiliary generation attributes to the child trace")
  assert.equal(metaOf(childGen).kind, "title")
  assert.equal(childGen.body.parentObservationId, expectedRootId("ses_child"))
  assert.ok(!flat.some((e) => e.body.id === expectedTraceId("ses_parent")), "an unobserved parent creates no fake trace")
  assert.equal(
    pendingSessionClean(tracker) || tracker.pendingSessionIds().every((id) => id === SID || id === "ses_child"),
    true,
  )
})

test("metadata-only preset exports no provider text and still redacts metadata strings", async () => {
  const transport = fakeTransport()
  const tracker = createTracker({
    transport,
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    pricing: testPricing(),
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
    pricing: testPricing(),
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

test("computed cost follows each request's own model across a model switch", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(
    transport,
    { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }, logs) },
    { messages: logs },
  )
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_a", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_a", "tool-calls", BASE + 220, 3))
  tracker.handleEvent(stepStarted("msg_b", { model: "glm-5.2", started: BASE + 250, created: BASE + 251, seq: 4 }))
  tracker.handleEvent(
    ev(
      "session.step.ended",
      BASE + 262,
      {
        sessionID: SID,
        assistantMessageID: "msg_b",
        finish: "stop",
        // No host cost on this event: no hostCost metadata may be invented.
        tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } },
      },
      5,
    ),
  )
  await tracker.flushAll()

  const primaries = generationsOf(flatten(transport)).filter((e) => e.body.name === "llm-generation")
  assert.equal(primaries.length, 2)
  const [genA, genB] = primaries
  assert.equal(genA.body.model, "mock-1")
  const costA = genA.body.costDetails as Record<string, number>
  near(costA.total, 0.00011925, "mock-1 uses the config override rates")
  assert.equal(metaOf(genA).pricingSource, "config")
  assert.equal(metaOf(genA).hostCost, 5, "host value recorded but not used")

  assert.equal(genB.body.model, "glm-5.2")
  const costB = genB.body.costDetails as Record<string, number>
  near(costB.total, 0.0000839, "glm-5.2 uses bundled rates for its own request")
  assert.equal(metaOf(genB).pricingSource, "bundled")
  assert.ok(!("hostCost" in metaOf(genB)), "a step without a host cost emits no hostCost metadata")
  assert.equal(omissionWarnings(logs).length, 0)
})

test("a deliberately wrong host cost never changes the computed cost", async () => {
  const transport = fakeTransport()
  let wrong = true
  const stepEndedWithCost = (id: string, created: number, seq: number) => ({
    ...ev(
      "session.step.ended",
      created,
      {
        sessionID: SID,
        assistantMessageID: id,
        finish: "stop",
        cost: wrong ? 999 : 5,
        tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } },
      },
      seq,
    ),
  })
  const tracker = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }) })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_w", { seq: 2 }))
  tracker.handleEvent(stepEndedWithCost("msg_w", BASE + 300, 3))
  await tracker.flushAll()
  const wrongCost = generationsOf(flatten(transport))[0]
  near((wrongCost.body.costDetails as Record<string, number>).total, 0.00011925)
  assert.equal(metaOf(wrongCost).hostCost, 999)

  wrong = false
  const tracker2 = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }) })
  tracker2.handleEvent(inboxPrompt("p"))
  tracker2.handleEvent(stepStarted("msg_w", { seq: 2 }))
  tracker2.handleEvent(stepEndedWithCost("msg_w", BASE + 300, 3))
  await tracker2.flushAll()
  const rightCost = generationsOf(flatten(transport).slice(-2))[0]
  assert.deepEqual(
    rightCost.body.costDetails,
    wrongCost.body.costDetails,
    "computed cost is identical regardless of the host value",
  )
})

test("an invalid diagnostic host cost never rejects valid usage or terminal state", async () => {
  for (const bogus of ["0.5", -3, Number.NaN, { total: 1 }]) {
    const transport = fakeTransport()
    const tracker = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }) })
    tracker.handleEvent(inboxPrompt("p"))
    tracker.handleEvent(stepStarted("msg_i", { seq: 2 }))
    tracker.handleEvent(
      ev(
        "session.step.ended",
        BASE + 300,
        {
          sessionID: SID,
          assistantMessageID: "msg_i",
          finish: "stop",
          cost: bogus,
          tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } },
        },
        3,
      ),
    )
    await tracker.flushAll()
    const gen = generationsOf(flatten(transport))[0]
    assert.equal(metaOf(gen).captureStatus, "completed", `bogus cost ${JSON.stringify(bogus)} is ignored`)
    assert.deepEqual(gen.body.usageDetails, { input: 37, output: 5, total: 49, reasoning: 2, cacheRead: 5 })
    assert.ok(!("hostCost" in metaOf(gen)), `bogus cost ${JSON.stringify(bogus)} is not exported`)
    near((gen.body.costDetails as Record<string, number>).total, 0.00011925)
  }
})

test("a failure without usage emits no computed cost and no missing-price warning", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, { pricing: testPricing(undefined, logs) }, { messages: logs })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_bare", { seq: 2 }))
  tracker.handleEvent(
    ev(
      "session.step.failed",
      BASE + 700,
      {
        sessionID: SID,
        assistantMessageID: "msg_bare",
        error: { type: "provider", message: "boom" },
        cost: 7,
      },
      3,
    ),
  )
  await tracker.flushAll()
  const gen = generationsOf(flatten(transport))[0]
  assert.equal(metaOf(gen).captureStatus, "error")
  assert.equal(metaOf(gen).hostCost, 7, "host cost is still diagnostic metadata")
  assert.ok(!("costDetails" in gen.body), "no usage means no cost")
  assert.ok(!("usageDetails" in gen.body))
  assert.equal(omissionWarnings(logs).length, 0, "pricing is never invoked without usage")
})

test("a recovered missing-start generation prices from its recovered model", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(
    transport,
    {
      pricing: testPricing({ "mock/mock-2": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, logs),
      lookupAssistant: async (_sessionID, assistantMessageID): Promise<AssistantSnapshot | undefined> =>
        assistantMessageID === "msg_lost"
          ? { id: "msg_lost", agent: "build", model: { id: "mock-2", providerID: "mock" }, createdAt: BASE + 50, streamedAt: BASE + 90 }
          : undefined,
    },
    { messages: logs },
  )
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepEnded("msg_lost", "stop", BASE + 120, 2))
  await tracker.flushNow(SID)

  const gen = generationsOf(flatten(transport))[0]
  assert.equal(gen.body.model, "mock-2", "cost follows the recovered identity, not a default")
  const cost = gen.body.costDetails as Record<string, number>
  near(cost.total, (37 * 3 + 5 * 15 + 2 * 15 + 5 * 0.3) / 1_000_000)
  assert.equal(metaOf(gen).pricingSource, "config")
  assert.equal(omissionWarnings(logs).length, 0)
})

test("duplicate durable endings do not re-price or re-export", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }) })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_d", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_d", "stop", BASE + 300, 3))
  tracker.handleEvent(stepEnded("msg_d", "stop", BASE + 300, 3))
  await tracker.flushAll()
  const events = flatten(transport).filter((e) => e.body.id === expectedGenerationId(SID, "msg_d"))
  assert.equal(events.length, 1, "exactly one generation event for the duplicated ending")
  assert.equal(events[0].type, "generation-create")
  assert.ok("costDetails" in events[0].body)
})

test("an unexported create coalesces usage and cost into one complete create", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }), flushDelayMs: 60_000 })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_c", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_c", "stop", BASE + 300, 3))
  await tracker.flushNow(SID)

  const events = flatten(transport).filter((e) => e.body.id === expectedGenerationId(SID, "msg_c"))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "generation-create", "create and pricing coalesce before the first export")
  assert.deepEqual(events[0].body.usageDetails, { input: 37, output: 5, total: 49, reasoning: 2, cacheRead: 5 })
  near((events[0].body.costDetails as Record<string, number>).total, 0.00011925)
})

test("a create exported while pricing was pending is completed by an ordered update", async () => {
  const gate = Promise.withResolvers<unknown>()
  const transport = fakeTransport()
  const resolver = createPricingResolver({
    overrides: { "mock/mock-1": OVERRIDE_PRICE },
    loadCatalog: () => gate.promise,
    log: () => {},
  })
  const tracker = createTracker({
    transport,
    policy: POLICY,
    pricing: resolver,
    flushDelayMs: 5,
    newId: (() => {
      let seq = 0
      return () => `id-${(seq += 1)}`
    })(),
    now: () => BASE + 10_000,
    log: () => {},
  })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_p", { seq: 2 }))
  await tracker.flushNow(SID)
  assert.equal(transport.batches.length, 1, "create exports without usage while pricing waits")
  const create = transport.batches[0].find((e) => e.type === "generation-create")
  assert.ok(create && !("costDetails" in create.body))

  tracker.handleEvent(stepEnded("msg_p", "stop", BASE + 300, 3))
  // The session chain is held by the pending quote; nothing exports yet.
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(transport.batches.length, 1, "the pending quote holds this session's export")

  gate.resolve({ data: [] })
  await tracker.flushNow(SID)
  const update = flatten(transport).find((e) => e.type === "generation-update" && e.body.id === expectedGenerationId(SID, "msg_p"))
  assert.ok(update, "cost arrives in an update on the same observation")
  assert.ok("costDetails" in update.body)
  near((update.body.costDetails as Record<string, number>).total, 0.00011925)
  // The submitted create snapshot was never mutated retroactively.
  assert.ok(!("costDetails" in transport.batches[0].find((e) => e.type === "generation-create")!.body))
})

test("terminal state and pricing resolve while ingest is held, then export in order", async () => {
  const release = Promise.withResolvers<void>()
  const transport = fakeTransport()
  const settledIngest = transport.ingest.bind(transport)
  let ingestCalls = 0
  // Holds every POST until released: the event path keeps working meanwhile.
  transport.ingest = async (events, options) => {
    ingestCalls += 1
    await release.promise
    return settledIngest(events, options)
  }
  const tracker = makeTracker(transport, { pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }), flushDelayMs: 5 })
  const first = tracker.flushNow(SID).then(() => tracker.flushNow(SID))
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_h", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_h", "stop", BASE + 300, 3))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(ingestCalls > 0, true, "a flush is already held on the transport")
  release.resolve()
  await first

  const genEvents = flatten(transport).filter((e) => e.body.id === expectedGenerationId(SID, "msg_h"))
  assert.equal(genEvents.length, 1)
  assert.equal(genEvents[0].type, "generation-create", "held ingest coalesces terminal + pricing into one create")
  near((genEvents[0].body.costDetails as Record<string, number>).total, 0.00011925)
  assert.equal(metaOf(genEvents[0]).captureStatus, "completed")
})

test("late pricing completion after closing creates no exports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const gate = Promise.withResolvers<unknown>()
  const transport = fakeTransport()
  const resolver = createPricingResolver({
    loadCatalog: () => gate.promise,
    log: () => {},
  })
  const tracker = createTracker({
    transport,
    policy: POLICY,
    pricing: resolver,
    flushDelayMs: 5,
    newId: () => `id-${Math.random()}`,
    now: () => BASE,
    log: () => {},
  })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_late", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_late", "stop", BASE + 300, 3))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(transport.batches.length, 0, "the pending quote holds the export")

  const shutdown = tracker.shutdown()
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(5_000)
  await shutdown
  const callsAtShutdown = transport.ingestCalls

  gate.resolve({ data: [] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(transport.ingestCalls, callsAtShutdown, "late quote completion exports nothing after close")
})

test("an unavailable generation (no model) gets no cost and no missing-price warning", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, { pricing: testPricing(undefined, logs) }, { messages: logs })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepEnded("msg_ghost", "stop", BASE + 120, 2))
  await tracker.flushNow(SID)
  const gen = generationsOf(flatten(transport))[0]
  assert.equal(metaOf(gen).captureStatus, "unavailable")
  assert.ok(!("costDetails" in gen.body))
  assert.equal(omissionWarnings(logs).length, 0, "missing model never invokes pricing")
})

test("metadata-only preset keeps numeric cost and omits content", async () => {
  const transport = fakeTransport()
  const tracker = createTracker({
    transport,
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    pricing: testPricing({ "mock/mock-1": OVERRIDE_PRICE }),
    flushDelayMs: 5,
    newId: () => `id-${Math.random()}`,
    now: () => BASE,
    log: () => {},
  })
  tracker.handleEvent(inboxPrompt("prompt carrying sk-lf-tokensecretvalue"))
  tracker.handleEvent(stepStarted("msg_mo", { seq: 2 }))
  tracker.handleEvent(textEnded("response carrying sk-lf-outputsecretvalue", BASE + 300, 3))
  tracker.handleEvent(stepEnded("msg_mo", "stop", BASE + 310, 4))
  await tracker.flushAll()
  const wire = JSON.stringify(transport.batches)
  assert.ok(!wire.includes("tokensecretvalue"))
  const gen = generationsOf(flatten(transport)).find((e) => e.body.name === "llm-generation")!
  assert.ok(!("input" in gen.body) && !("output" in gen.body))
  near((gen.body.costDetails as Record<string, number>).total, 0.00011925, "numeric cost survives metadata-only")
  assert.equal(metaOf(gen).pricingSource, "config")
  assert.equal(metaOf(gen).hostCost, 5)
})

test("catalog quotes export honest tier metadata", async () => {
  const transport = fakeTransport()
  const resolver = createPricingResolver({
    loadCatalog: async () => ({
      data: [
        {
          id: "mock-1",
          providerID: "mock",
          cost: [
            { input: 1.5, output: 9, cache: { read: 0.15, write: 1.25 } },
            { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0.6 }, tier: { type: "context", size: 200_000 } },
          ],
        },
      ],
    }),
    log: () => {},
  })
  const tracker = createTracker({
    transport,
    policy: POLICY,
    pricing: resolver,
    flushDelayMs: 5,
    newId: () => `id-${Math.random()}`,
    now: () => BASE,
    log: () => {},
  })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_tier", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_tier", "stop", BASE + 300, 3))
  await tracker.flushAll()
  const gen = generationsOf(flatten(transport)).find((e) => e.body.name === "llm-generation")!
  assert.equal(metaOf(gen).pricingSource, "catalog")
  assert.equal(metaOf(gen).pricingTier, 0)
  assert.equal(metaOf(gen).pricingTierCount, 2)
  assert.equal(metaOf(gen).pricingTierApproximation, "first-tier")
  near((gen.body.costDetails as Record<string, number>).total, 0.00011925, "tier zero carries the quote")
})

test("bundled off-peak quotes export pricingAssumption metadata", async () => {
  const transport = fakeTransport()
  const tracker = makeTracker(transport, { pricing: testPricing() })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_ds", { model: "deepseek-v4-flash", seq: 2 }))
  tracker.handleEvent(stepEnded("msg_ds", "stop", BASE + 300, 3))
  await tracker.flushAll()
  const gen = generationsOf(flatten(transport)).find((e) => e.body.name === "llm-generation")!
  assert.equal(metaOf(gen).pricingSource, "bundled")
  assert.equal(metaOf(gen).pricingAssumption, "off-peak")
  const cost = gen.body.costDetails as Record<string, number>
  near(cost.total, (37 * 0.22 + 5 * 0.66 + 2 * 0.66 + 5 * 0.007) / 1_000_000)
  assert.ok(!("cacheWrite" in cost))
})

test("an unpriced primary omits costDetails entirely and warns once per tracker", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, { pricing: testPricing(undefined, logs) }, { messages: logs })
  tracker.handleEvent(inboxPrompt("p"))
  tracker.handleEvent(stepStarted("msg_u1", { seq: 2 }))
  tracker.handleEvent(stepEnded("msg_u1", "stop", BASE + 300, 3))
  tracker.handleEvent(stepStarted("msg_u2", { model: "mock-2", started: BASE + 320, created: BASE + 321, seq: 4 }))
  tracker.handleEvent(stepEnded("msg_u2", "stop", BASE + 330, 5))
  await tracker.flushAll()
  for (const gen of generationsOf(flatten(transport)).filter((e) => e.body.name === "llm-generation")) {
    assert.ok(!("costDetails" in gen.body), "unresolved price means absent costDetails, not {total: 0}")
    assert.ok(!("pricingSource" in metaOf(gen)))
  }
  assert.equal(omissionWarnings(logs).filter((m) => m.includes("mock/mock-1")).length, 1)
  assert.equal(omissionWarnings(logs).filter((m) => m.includes("mock/mock-2")).length, 1)
})

// ---- feature-013: child admission, linkage, and grouping boundaries.

test("a late birth corrects an unclassified cold state under the same deterministic identity", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const child = "ses_late_child"
  let lookupWorks = false
  const tracker = makeTracker(
    transport,
    {
      lookupSession: async (id) => {
        if (id !== child || !lookupWorks) {
          throw new Error("native unavailable")
        }
        return { parentID: SID, agent: "general" }
      },
    },
    logs,
  )
  // Cold facts arrive while the lookup fails: fail open, no invented linkage.
  tracker.handleEvent(ev("session.inbox.enqueued", BASE + 100, { sessionID: child, item: { type: "user", payload: { text: "child prompt" } } }, 1))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: child }, 2))
  await tracker.flushAll()
  const initial = flatten(transport).find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(child))
  assert.ok(initial)
  assert.equal(initial.body.name, "opencode-agent", "unclassified state exports as a plain session")
  assert.equal(initial.body.sessionId, child)
  assert.equal(metaOf(initial).parentSessionID, undefined)

  // The birth arrives late: same ids, now child-named and parent-grouped.
  lookupWorks = true
  tracker.handleEvent(ev("session.created", BASE, { sessionID: child, parentID: SID, agent: "general" }, 0))
  await tracker.flushAll()
  const revisions = flatten(transport).filter((e) => e.type === "trace-create" && e.body.id === expectedTraceId(child))
  assert.ok(revisions.length >= 2, "the same trace id is upserted")
  const last = revisions[revisions.length - 1]
  assert.equal(last.body.name, "opencode-subagent:general")
  assert.equal(last.body.sessionId, SID)
  assert.equal(metaOf(last).parentSessionID, SID)
  assert.equal(metaOf(last).parent_trace_id, expectedTraceId(SID))
})

test("native birth facts admit a child even when the info lookup fails", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const child = "ses_birth_child"
  const tracker = makeTracker(
    transport,
    {
      lookupSession: async () => {
        throw new Error("lookup down")
      },
    },
    logs,
  )
  tracker.handleEvent(ev("session.created", BASE, { sessionID: child, parentID: SID, agent: "general", location: { directory: "/tmp" } }, 0))
  tracker.handleEvent(ev("session.inbox.enqueued", BASE + 100, { sessionID: child, item: { type: "user", payload: { text: "prompt" } } }, 1))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: child }, 2))
  await tracker.flushAll()
  const flat = flatten(transport)
  const trace = flat.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(child))
  assert.ok(trace)
  assert.equal(trace.body.name, "opencode-subagent:general")
  assert.equal(trace.body.sessionId, SID)
  assert.equal(metaOf(trace).parentSessionID, SID)
  assert.ok(logs.messages.some((m) => m.includes("failed session lookup")), "lookup failure still diagnosed")
})

test("identical assistant and tool ids across parent and children stay distinct", async () => {
  const transport = fakeTransport()
  const childA = "ses_twin_a"
  const childB = "ses_twin_b"
  const tracker = makeTracker(transport, {
    lookupSession: async (id) => (id === SID ? undefined : { parentID: SID, agent: "general" }),
  })
  for (const sid of [SID, childA, childB]) {
    tracker.handleEvent(ev("session.created", BASE, { sessionID: sid, ...(sid === SID ? {} : { parentID: SID, agent: "general" }) }, 0))
    tracker.handleEvent(ev("session.step.started", BASE + 200, { sessionID: sid, assistantMessageID: "msg_1", agent: "build", model: { id: "mock-1", providerID: "mock" }, started: BASE + 199 }, 1))
    tracker.handleEvent(ev("session.tool.input.started", BASE + 205, { sessionID: sid, assistantMessageID: "msg_1", id: "call_1", name: "shell" }, 2))
    tracker.handleEvent(ev("session.tool.called", BASE + 210, { sessionID: sid, assistantMessageID: "msg_1", id: "call_1", input: { command: "x" }, executed: false }, 3))
    tracker.handleEvent(ev("session.tool.success", BASE + 260, { sessionID: sid, assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "ok" }], metadata: {} }, 4))
    tracker.handleEvent(ev("session.step.ended", BASE + 310, { sessionID: sid, assistantMessageID: "msg_1", finish: "stop", cost: 5, tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } } }, 5))
    tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: sid }, 6))
  }
  await tracker.flushAll()
  const flat = flatten(transport)
  for (const sid of [SID, childA, childB]) {
    const traceId = expectedTraceId(sid)
    const trace = flat.find((e) => e.type === "trace-create" && e.body.id === traceId)
    assert.ok(trace, `trace exists for ${sid}`)
    const primary = flat.filter((e) => e.type.startsWith("generation-") && e.body.traceId === traceId && metaOf(e).kind === "primary")
    assert.equal(primary.length, 1, `exactly one primary for ${sid}`)
    assert.equal(primary[0].body.id, expectedGenerationId(sid, "msg_1"))
    const span = flat.find((e) => (e.type === "span-create" || e.type === "span-update") && metaOf(e).kind === "tool" && metaOf(e).sessionId === sid)
    assert.ok(span, `tool span attributed to ${sid}`)
    assert.equal(span.body.id, createHash("sha256").update(`opencode-langfuse:tool:${sid}:msg_1:call_1`, "utf8").digest("hex").slice(0, 16))
    if (sid === SID) {
      assert.equal(trace.body.name, "opencode-agent")
    } else {
      assert.equal(trace.body.name, "opencode-subagent:general")
      assert.equal(trace.body.sessionId, SID)
      assert.equal(metaOf(trace).parentSessionID, SID)
    }
  }
})

test("a grandchild links to its direct parent, not a guessed ancestor", async () => {
  const transport = fakeTransport()
  const mid = "ses_mid_child"
  const grand = "ses_grand_child"
  const tracker = makeTracker(transport, {
    lookupSession: async (id) => (id === mid ? { parentID: SID, agent: "general" } : id === grand ? { parentID: mid, agent: "general" } : undefined),
  })
  tracker.handleEvent(ev("session.created", BASE, { sessionID: grand, parentID: mid, agent: "general" }, 0))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: grand }, 1))
  await tracker.flushAll()
  const trace = flatten(transport).find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(grand))
  assert.ok(trace)
  assert.equal(metaOf(trace).parentSessionID, mid, "direct parent, never the interactive ancestor")
  assert.equal(metaOf(trace).parent_trace_id, expectedTraceId(mid))
  assert.equal(trace.body.sessionId, mid)
})

test("an unusable or missing agent name falls back to the safe subagent label", async () => {
  const transport = fakeTransport()
  const secret = "ses_agent_secret"
  const unusable = "ses_agent_unusable"
  const missing = "ses_agent_missing"
  const tracker = makeTracker(transport, { lookupSession: async () => undefined })
  tracker.handleEvent(ev("session.created", BASE, { sessionID: secret, parentID: SID, agent: "sk-ant-feature1113-canary general" }, 0))
  tracker.handleEvent(ev("session.created", BASE + 1, { sessionID: unusable, parentID: SID, agent: "///" }, 0))
  tracker.handleEvent(ev("session.created", BASE + 2, { sessionID: missing, parentID: SID }, 0))
  for (const sid of [secret, unusable, missing]) {
    tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: sid }, 1))
  }
  await tracker.flushAll()
  const flat = flatten(transport)
  const secretTrace = flat.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(secret))
  assert.ok(secretTrace)
  assert.ok(!String(secretTrace.body.name).includes("sk-ant-feature1113-canary"))
  const unusableTrace = flat.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(unusable))
  assert.equal(unusableTrace?.body.name, "opencode-subagent:subagent")
  const missingTrace = flat.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(missing))
  assert.equal(missingTrace?.body.name, "opencode-subagent:subagent")
})

test("duplicate births and warm continuation keep linkage and counts stable", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const child = "ses_dup_child"
  const tracker = makeTracker(transport, {}, logs)
  tracker.handleEvent(ev("session.created", BASE, { sessionID: child, parentID: SID, agent: "general" }, 0))
  tracker.handleEvent(ev("session.created", BASE + 1, { sessionID: child, parentID: SID, agent: "general" }, 1))
  tracker.handleEvent(ev("session.step.started", BASE + 200, { sessionID: child, assistantMessageID: "msg_c1", agent: "general", model: { id: "mock-1", providerID: "mock" }, started: BASE + 199 }, 2))
  tracker.handleEvent(ev("session.step.ended", BASE + 310, { sessionID: child, assistantMessageID: "msg_c1", finish: "stop", cost: 5, tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } } }, 3))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: child }, 4))
  await tracker.flushAll()
  let scores = flatten(transport).filter((e) => e.type === "score-create" && e.body.traceId === expectedTraceId(child))
  assert.equal(scores.length, 5)
  const turnScore = scores.find((e) => e.body.name === "turn_count")
  assert.equal(turnScore?.body.value, 1, "duplicate births never duplicate ledger facts")

  // Warm continuation: another turn, same trace, linkage intact.
  tracker.handleEvent(ev("session.created", BASE + 500, { sessionID: child, parentID: SID, agent: "general" }, 5))
  tracker.handleEvent(ev("session.step.started", BASE + 600, { sessionID: child, assistantMessageID: "msg_c2", agent: "general", model: { id: "mock-1", providerID: "mock" }, started: BASE + 599 }, 6))
  tracker.handleEvent(ev("session.step.ended", BASE + 610, { sessionID: child, assistantMessageID: "msg_c2", finish: "stop", cost: 5, tokens: { input: 9, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, 7))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 620, { sessionID: child }, 8))
  await tracker.flushAll()
  const revisions = flatten(transport).filter((e) => e.type === "trace-create" && e.body.id === expectedTraceId(child))
  const last = revisions[revisions.length - 1]
  assert.equal(last.body.name, "opencode-subagent:general")
  assert.equal(metaOf(last).parentSessionID, SID)
  assert.equal(metaOf(last).parent_trace_id, expectedTraceId(SID))
  scores = flatten(transport).filter((e) => e.type === "score-create" && e.body.traceId === expectedTraceId(child))
  const turns = scores.filter((e) => e.body.name === "turn_count")
  assert.equal(turns.length, 2, "ordered updates, not duplicated facts")
  assert.equal(turns[1].body.value, 2)
})

test("children count toward the tracked-session capacity", async () => {
  const transport = fakeTransport()
  const logs: LogSpy = { messages: [] }
  const tracker = makeTracker(transport, {}, logs)
  const pending: Promise<void>[] = []
  for (let i = 0; i < 256; i += 1) {
    pending.push(
      tracker.handleEvent(ev("session.created", BASE + i, { sessionID: `ses_child_${i}`, parentID: "ses_root", agent: "general" }, 0)),
    )
  }
  pending.push(tracker.handleEvent(ev("session.created", BASE + 999, { sessionID: "ses_child_over", parentID: "ses_root", agent: "general" }, 0)))
  await Promise.all(pending)
  const ids = tracker.pendingSessionIds()
  assert.ok(!ids.includes("ses_child_over"))
  assert.equal(logs.messages.filter((m) => m.includes("tracked session capacity")).length, 1)
})

test("held ingestion keeps submitted batches unchanged while the ordered next batch retains child metadata", async () => {
  const batches: IngestEvent[][] = []
  const gated: (() => void)[] = []
  const transport: LangfuseTransport = {
    async ingest(events) {
      batches.push(events)
      await new Promise<void>((resolve) => gated.push(resolve))
      return { accepted: events.length, failed: 0 }
    },
  }
  const logs: LogSpy = { messages: [] }
  const child = "ses_held_child"
  const tracker = makeTracker(transport as never, {}, logs)
  tracker.handleEvent(ev("session.inbox.enqueued", BASE + 100, { sessionID: SID, item: { type: "user", payload: { text: "parent prompt" } } }, 1))
  const parentFlush = tracker.flushNow(SID)
  await new Promise<void>((resolve) => setImmediate(resolve))
  tracker.handleEvent(ev("session.created", BASE, { sessionID: child, parentID: SID, agent: "general" }, 0))
  tracker.handleEvent(ev("session.execution.succeeded", BASE + 400, { sessionID: child }, 1))
  const childFlush = tracker.flushNow(child)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(batches.length, 2, "parent batch is on the wire, child batch is held behind it")
  assert.ok(!JSON.stringify(batches[0]).includes("ses_held_child"), "the submitted parent batch is unchanged by child facts")

  gated[0]()
  gated[1]()
  await Promise.all([parentFlush, childFlush])
  const childBatch = batches[1].flat()
  const childTrace = childBatch.find((e) => e.type === "trace-create" && e.body.id === expectedTraceId(child))
  assert.ok(childTrace)
  assert.equal(childTrace.body.name, "opencode-subagent:general")
  assert.equal(metaOf(childTrace).parentSessionID, SID)
})
