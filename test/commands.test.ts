/**
 * Feature-012 operational commands (ADR-0005): server-log-only status/test
 * over the ACTIVE configuration, standalone test traces through the real
 * transport, runtime-error retention, and close-time cancellation.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createCapturePolicy } from "../src/capture-policy.js"
import { createLangfuseCommands } from "../src/commands.js"
import { createLangfuseTransport } from "../src/langfuse.js"
import type { IngestEvent } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver } from "../src/pricing.js"
import { createRuntimeStatus } from "../src/runtime-status.js"
import { createTracker, type Tracker, type TrackerOptions } from "../src/tracker.js"

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>

interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>
  body: { metadata?: unknown; batch?: Array<{ type: string; body: Record<string, unknown> }> }
  respond(status: number, payload: unknown): void
}

/** Loopback ingestion recorder with explicit response control. */
async function startRecorder(): Promise<{
  port: number
  requests: RecordedRequest[]
  /** Resolves once at least `count` requests have arrived. */
  waitForRequests(count: number): Promise<void>
  close(): Promise<void>
}> {
  const requests: RecordedRequest[] = []
  const arrivalWaiters = new Set<() => void>()
  const waitForRequests = (count: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (requests.length >= count) {
          arrivalWaiters.delete(check)
          resolve()
        }
      }
      arrivalWaiters.add(check)
      check()
    })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const recorded: RecordedRequest = {
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : {},
        respond: (status, payload) => {
          res.writeHead(status, { "content-type": "application/json" })
          res.end(JSON.stringify(payload))
        },
      }
      requests.push(recorded)
      for (const waiter of [...arrivalWaiters]) {
        waiter()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return {
    port,
    requests,
    waitForRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function makeCommands(
  recorder: { port: number } | undefined,
  overrides: {
    policy?: ReturnType<typeof createCapturePolicy>
    preset?: "metadata-only" | "prompts-only" | "conversations" | "full-debug"
    newId?: () => string
    log?: (message: string) => void
  } = {},
) {
  const runtimeStatus = createRuntimeStatus()
  const log = overrides.log ?? (() => {})
  const config =
    recorder === undefined
      ? ({ source: "none", reason: "no LANGFUSE_* env vars; ~/.config/opencode-langfuse/config.json: config file not found" } as const)
      : ({
          source: "env",
          publicKey: "pk-test-public-1234567890abcdef",
          secretKey: "sk-test-secret-9876543210",
          host: `http://127.0.0.1:${recorder.port}`,
        } as const)
  const transport =
    recorder === undefined
      ? undefined
      : createLangfuseTransport(
          { host: `http://127.0.0.1:${recorder.port}`, publicKey: "pk-t", secretKey: "sk-t" },
          { attempts: 1, log },
        )
  const commands = createLangfuseCommands({
    config,
    policy: overrides.policy ?? createCapturePolicy({ preset: "full-debug", env: FULL_ENV }),
    preset: overrides.preset ?? "full-debug",
    runtimeStatus,
    transport,
    log,
    now: () => 1_700_000_000_000,
    newId: overrides.newId,
  })
  return { commands, runtimeStatus, config }
}

function collectCommands(host: `http://127.0.0.1:${number}`, runtimeStatus: ReturnType<typeof createRuntimeStatus>, log: (message: string) => void, newId?: () => string) {
  return createLangfuseCommands({
    config: {
      source: "env",
      publicKey: "pk-collect-1234567890",
      secretKey: "sk-collect-0987654321",
      host,
    },
    policy: createCapturePolicy({ preset: "full-debug", env: FULL_ENV }),
    preset: "full-debug",
    runtimeStatus,
    transport: createLangfuseTransport({ host, publicKey: "pk-c", secretKey: "sk-c" }, { attempts: 1, log }),
    log,
    now: () => 1_700_000_000_000,
    newId,
  })
}

// ---- status output.

test("disabled status reports source none, reason, preset and flags without secrets", async () => {
  const lines: string[] = []
  const { commands } = makeCommands(undefined, {
    policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
    preset: "metadata-only",
    log: (m) => lines.push(m),
  })
  await commands.status()
  const text = lines.join("\n")
  assert.ok(text.includes("State: disabled"))
  assert.ok(text.includes("Config source: none"))
  assert.ok(text.includes("Host: not configured"))
  assert.ok(text.includes("Public key: not configured"))
  assert.ok(text.includes("Privacy preset: metadata-only"))
  for (const flag of ["captureInputs", "captureOutputs", "captureToolIo", "captureSystemPrompt", "captureCwd"]) {
    assert.ok(text.includes(`${flag}: off`), `expected ${flag}: off`)
  }
  assert.ok(text.includes("Last runtime error: none"))
  assert.ok(text.includes("Reason: no LANGFUSE_* env vars"))
  await commands.test()
  assert.ok(
    lines.some((m) => m.includes("Langfuse test unavailable")),
    lines.join("\n"),
  )
  assert.ok(!lines.some((m) => m.includes("Langfuse test succeeded")))
})

test("configured status shows the active env source, masked key, redacted host, and overridden flags", async () => {
  const recorder = await startRecorder()
  try {
    const lines: string[] = []
    const policy = createCapturePolicy({
      preset: "metadata-only",
      env: { ...FULL_ENV, LANGFUSE_CAPTURE_INPUTS: "1", LANGFUSE_CAPTURE_CWD: "1" },
    })
    const host = `http://user:pass@127.0.0.1:${recorder.port}/base?token=secret-token-value`
    const runtimeStatus = createRuntimeStatus()
    const commands = createLangfuseCommands({
      config: {
        source: "env",
        publicKey: "pk-test-public-1234567890abcdef",
        secretKey: "sk-test-secret-9876543210",
        host,
      },
      policy,
      preset: "metadata-only",
      runtimeStatus,
      transport: createLangfuseTransport(
        { host: `http://127.0.0.1:${recorder.port}`, publicKey: "pk-t", secretKey: "sk-t" },
        { attempts: 1, log: () => {} },
      ),
      log: (m) => lines.push(m),
    })
    await commands.status()
    const text = lines.join("\n")
    assert.ok(text.includes("State: enabled"))
    assert.ok(text.includes("Config source: env"))
    assert.ok(text.includes(`Host: http://127.0.0.1:${recorder.port}/`))
    assert.ok(!text.includes("user:pass"))
    assert.ok(!text.includes("token=secret-token-value"))
    assert.ok(text.includes("Public key: pk-test…cdef"))
    assert.ok(!text.includes("sk-test-secret-9876543210"))
    assert.ok(!text.includes("pk-test-public-1234567890abcdef"))
    assert.ok(text.includes("Privacy preset: metadata-only"))
    assert.ok(text.includes("captureInputs: on"))
    assert.ok(text.includes("captureOutputs: off"))
    assert.ok(text.includes("captureToolIo: off"))
    assert.ok(text.includes("captureSystemPrompt: off"))
    assert.ok(text.includes("captureCwd: on"))
    // The policy instance is shared with the caller: mutating nothing, the
    // displayed flags are the tracker's flags.
    assert.equal(policy.captureInputs, true)
  } finally {
    await recorder.close()
  }
})

// ---- test command over the real transport and loopback recorder.

test("full acceptance succeeds with fresh standalone trace ids per invocation", async () => {
  const recorder = await startRecorder()
  try {
    const lines: string[] = []
    let seq = 0
    const { commands } = makeCommands(recorder, {
      newId: () => `uuid-${(seq += 1)}-abcd-ef01`,
      log: (m) => lines.push(m),
    })
    const first = commands.test()
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(200, { accepted: 2 })
    await first
    assert.equal(recorder.requests.length, 1)
    assert.ok(lines.some((m) => m.startsWith("Langfuse test succeeded; traceId=uuid1abcdef01")), lines.join("\n"))
    const firstBatch = recorder.requests[0].body.batch ?? []
    assert.deepEqual(firstBatch.map((e) => e.type), ["trace-create", "span-create"])

    lines.length = 0
    const second = commands.test()
    await recorder.waitForRequests(2)
    recorder.requests[1].respond(200, { accepted: 2 })
    await second
    assert.equal(recorder.requests.length, 2)
    const secondBatch = recorder.requests[1].body.batch ?? []
    const firstTraceId = (firstBatch[0].body as { id: string }).id
    const secondTraceId = (secondBatch[0].body as { id: string }).id
    assert.notEqual(firstTraceId, secondTraceId)
    assert.notEqual(
      (firstBatch[1].body as { id: string }).id,
      (secondBatch[1].body as { id: string }).id,
    )
    assert.ok(lines.some((m) => m.startsWith("Langfuse test succeeded; traceId=")))
  } finally {
    await recorder.close()
  }
})

test("test payloads follow the capture policy and never carry session linkage or scores", async () => {
  const recorder = await startRecorder()
  try {
    // metadata-only: input/output absent.
    const metadataOnly = makeCommands(recorder, {
      policy: createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }),
      preset: "metadata-only",
      newId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })
    const metaPending = metadataOnly.commands.test()
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(200, { accepted: 2 })
    await metaPending
    const metaBatch = recorder.requests[0].body.batch ?? []
    for (const event of metaBatch) {
      assert.equal("input" in event.body, false)
      assert.equal("output" in event.body, false)
      assert.equal("sessionId" in event.body, false)
      assert.deepEqual(event.body.metadata, { source: "opencode-langfuse", command: "langfuse-test" })
    }
    const span = metaBatch[1].body as { level: string; startTime: string; endTime: string; traceId: string }
    assert.equal(span.level, "DEFAULT")
    assert.equal(span.startTime, span.endTime)

    // full-debug: fixed safe values present.
    recorder.requests.length = 0
    const fullDebug = makeCommands(recorder, {
      policy: createCapturePolicy({ preset: "full-debug", env: FULL_ENV }),
      newId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })
    const fullPending = fullDebug.commands.test()
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(200, { accepted: 2 })
    await fullPending
    const fullBatch = recorder.requests[0].body.batch ?? []
    assert.deepEqual(fullBatch[0].body.input, { command: "/langfuse-test" })
    assert.equal(fullBatch[0].body.output, "ok")
    assert.deepEqual(fullBatch[1].body.input, { command: "/langfuse-test" })
    assert.equal(fullBatch[1].body.output, "ok")
    assert.equal("sessionId" in fullBatch[0].body, false)
    assert.ok(recorder.requests[0].headers.authorization !== undefined)
    // No score events ever.
    assert.equal(recorder.requests[0].body.batch?.some((e) => e.type === "score-create"), false)
  } finally {
    await recorder.close()
  }
})

test("a 207 that accepts the trace but rejects the span fails the command and records the error", async () => {
  const recorder = await startRecorder()
  try {
    const lines: string[] = []
    const { commands, runtimeStatus } = makeCommands(recorder, { log: (m) => lines.push(m) })
    const pending = commands.test()
    await recorder.waitForRequests(1)
    const request = recorder.requests[0]
    const batch = request.body.batch ?? []
    request.respond(207, { accepted: 1, errors: [{ id: batch[1]?.body.id ?? "x", status: 400 }] })
    await pending
    assert.ok(lines.some((m) => m.includes("Langfuse test failed")), lines.join("\n"))
    const last = runtimeStatus.getLastError()
    assert.ok(last)
    assert.equal(last.scope, "langfuse-test")
    assert.ok(last.message.includes("accepted 1/2"))
  } finally {
    await recorder.close()
  }
})

test("a later success does not erase the earlier recorded failure", async () => {
  const recorder = await startRecorder()
  try {
    const lines: string[] = []
    const { commands, runtimeStatus } = makeCommands(recorder, { log: (m) => lines.push(m) })

    const failing = commands.test()
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(503, { errors: [] })
    await failing
    assert.ok(runtimeStatus.getLastError()?.scope === "langfuse-test")

    lines.length = 0
    const succeeding = commands.test()
    await recorder.waitForRequests(2)
    recorder.requests[1].respond(200, { accepted: 2 })
    await succeeding
    assert.ok(lines.some((m) => m.startsWith("Langfuse test succeeded")))
    const last = runtimeStatus.getLastError()
    assert.ok(last?.scope === "langfuse-test", "retained failure survives a later success")
  } finally {
    await recorder.close()
  }
})

test("closing aborts an in-flight test without stale output or new posts", async () => {
  const recorder = await startRecorder()
  try {
    const lines: string[] = []
    const { commands } = makeCommands(recorder, { log: (m) => lines.push(m) })
    const pending = commands.test()
    // Hold: wait until the POST arrived, then close before responding.
    await recorder.waitForRequests(1)
    assert.equal(recorder.requests.length, 1)
    commands.close()
    // Release the held request; the aborted ingest must not produce output.
    recorder.requests[0].respond(200, { accepted: 2 })
    await pending
    assert.equal(lines.filter((m) => m.includes("Langfuse test succeeded") || m.includes("Langfuse test failed")).length, 0)

    // A closed command produces nothing further and no new request.
    lines.length = 0
    await commands.test()
    await commands.status()
    assert.equal(lines.length, 0)
    assert.equal(recorder.requests.length, 1)
  } finally {
    await recorder.close()
  }
})

test("the transport notifies the runtime error slot on exhaustion and 207, not on transient retries", async () => {
  const recorder = await startRecorder()
  try {
    const errors: string[] = []
    const transport = createLangfuseTransport(
      { host: `http://127.0.0.1:${recorder.port}`, publicKey: "pk-t", secretKey: "sk-t" },
      { attempts: 2, log: () => {}, onError: (message) => errors.push(message) },
    )
    const events: IngestEvent[] = [{ id: "1", type: "trace-create", timestamp: "t", body: { id: "t" } }]

    // Transient failure then success: no notification.
    const transient = transport.ingest(events)
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(503, { errors: [] })
    await recorder.waitForRequests(2)
    recorder.requests[1].respond(200, { accepted: 1 })
    await transient
    assert.equal(errors.length, 0)

    // Exhaustion notifies once.
    const exhausted = transport.ingest(events)
    await recorder.waitForRequests(3)
    recorder.requests[2].respond(503, { errors: [] })
    await recorder.waitForRequests(4)
    recorder.requests[3].respond(503, { errors: [] })
    await exhausted
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes("Failed to ingest 1 event(s)"))
    assert.ok(errors[0].includes(`http://127.0.0.1:${recorder.port}/`))

    // 207 partial rejection notifies.
    const partial = transport.ingest(events)
    await recorder.waitForRequests(5)
    recorder.requests[4].respond(207, { accepted: 0, errors: [{ id: "t" }] })
    await partial
    assert.equal(errors.length, 2)
    assert.ok(errors[1].includes("partially rejected: 1/1"))
  } finally {
    await recorder.close()
  }
})

test("an invalid configured host never echoes credentials through transport errors", async () => {
  const errors: string[] = []
  // redactHost on the display path: transport errors carry the safe form.
  const transport = createLangfuseTransport(
    { host: "http://user:pass@127.0.0.1:1", publicKey: "pk", secretKey: "sk" },
    { attempts: 1, timeoutMs: 50, log: () => {}, onError: (message) => errors.push(message) },
  )
  await transport.ingest([{ id: "1", type: "trace-create", timestamp: "t", body: {} }])
  assert.equal(errors.length, 1)
  assert.ok(!errors[0].includes("user:pass"), errors[0])
  assert.ok(errors[0].includes("http://127.0.0.1:1/"))
})

// ---- tracker error wiring: diagnostics record; capacity warnings do not.

function testPricing(): PricingResolver {
  return createPricingResolver({ loadCatalog: async () => ({ data: [] }), log: () => {} })
}

test("tracker diagnostics notify the runtime error slot; capacity warnings do not", async () => {
  const errors: string[] = []
  const logs: string[] = []
  const batches: IngestEvent[][] = []
  let seq = 0
  const options: TrackerOptions = {
    transport: { async ingest(events) { batches.push(events); return { accepted: events.length, failed: 0 } } },
    policy: createCapturePolicy({ preset: "conversations", env: FULL_ENV }),
    pricing: testPricing(),
    flushDelayMs: 5,
    newId: () => `id-${(seq += 1)}`,
    now: () => 1_700_000_000_000,
    log: (m) => logs.push(m),
    onError: (m) => errors.push(m),
  }
  const tracker: Tracker = createTracker(options)
  const sid = "ses_errors"

  // Malformed payload → diagnostic → recorded.
  await tracker.handleEvent({
    type: "session.inbox.enqueued",
    created: 1_700_000_000_000,
    data: { sessionID: sid, item: { type: "user", payload: "not-an-object" } },
  })
  assert.ok(errors.some((m) => m.includes("malformed session.inbox.enqueued")))

  // Capacity warning (257 pending generations) → logged, never recorded.
  for (let i = 0; i < 257; i += 1) {
    await tracker.handleEvent({
      type: "session.step.started",
      created: 1_700_000_000_000 + i,
      data: {
        sessionID: sid,
        assistantMessageID: `msg_${i}`,
        agent: "build",
        model: { id: "mock-1", providerID: "mock" },
        started: 1_700_000_000_000 + i,
      },
    })
  }
  assert.ok(logs.some((m) => m.includes("pending generation capacity reached")))
  assert.equal(errors.filter((m) => m.includes("capacity")).length, 0)
  assert.ok(errors.every((m) => !m.includes("capacity")))
})

test("runtime error slots are isolated per plugin instance", async () => {
  const recorder = await startRecorder()
  try {
    const linesA: string[] = []
    const linesB: string[] = []
    const runtimeA = createRuntimeStatus()
    const runtimeB = createRuntimeStatus()
    const a = collectCommands(`http://127.0.0.1:${recorder.port}` as const, runtimeA, (m) => linesA.push(m))
    const b = collectCommands(`http://127.0.0.1:${recorder.port}` as const, runtimeB, (m) => linesB.push(m))
    const pendingA = a.test()
    await recorder.waitForRequests(1)
    recorder.requests[0].respond(503, { errors: [] })
    await pendingA
    assert.ok(runtimeA.getLastError()?.scope === "langfuse-test")
    assert.equal(runtimeB.getLastError(), undefined)
    const pendingB = b.test()
    await recorder.waitForRequests(2)
    recorder.requests[1].respond(200, { accepted: 2 })
    await pendingB
    assert.ok(linesB.some((m) => m.startsWith("Langfuse test succeeded")))
    assert.equal(runtimeB.getLastError(), undefined)
    assert.ok(runtimeA.getLastError()?.scope === "langfuse-test")
  } finally {
    await recorder.close()
  }
})
