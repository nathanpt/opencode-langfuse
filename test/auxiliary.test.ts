import assert from "node:assert/strict"
import { test } from "node:test"
import { observeAuxiliaryResponse, type AuxiliaryCompletion } from "../src/auxiliary.js"

const BASE = 1_700_000_000_000

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function collector(): { completions: AuxiliaryCompletion[]; on: (c: AuxiliaryCompletion) => void } {
  const completions: AuxiliaryCompletion[] = []
  return { completions, on: (c) => completions.push(c) }
}

test("pass-through delivers identical bytes, status, headers, and metadata, and supports caller clone", async () => {
  const { completions, on } = collector()
  const original = new Response(byteStream(["hello ", "world"]), {
    status: 207,
    statusText: "Multi-Status",
    headers: { "x-mock": "yes" },
  })
  Object.defineProperty(original, "url", { value: "http://mock/x", configurable: true })
  Object.defineProperty(original, "redirected", { value: true, configurable: true })

  const observed = observeAuxiliaryResponse(original, on, () => BASE + 42)
  assert.notEqual(observed.response, original)

  const clone = observed.response.clone()
  assert.equal(observed.response.status, 207)
  assert.equal(observed.response.statusText, "Multi-Status")
  assert.equal(observed.response.headers.get("x-mock"), "yes")
  assert.equal(observed.response.url, "http://mock/x")
  assert.equal(observed.response.redirected, true)
  assert.equal(observed.response.type, original.type)

  const [ours, theirs] = await Promise.all([observed.response.text(), clone.text()])
  assert.equal(ours, "hello world")
  assert.equal(theirs, "hello world")
  assert.deepEqual(completions, [{ at: BASE + 42, status: "completed" }])
})

test("no bytes are read ahead of consumer demand", async () => {
  const { on } = collector()
  let pulls = 0
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1
        controller.enqueue(new TextEncoder().encode(`chunk-${pulls}`))
        if (pulls >= 3) {
          controller.close()
        }
      },
    },
    { highWaterMark: 0 },
  )
  const original = new Response(source)
  const observed = observeAuxiliaryResponse(original, on)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(pulls, 0, "observer never reads before the consumer asks")

  const reader = observed.response.body!.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), "chunk-1")
  assert.equal(pulls, 1, "exactly one upstream read per consumer read")
  await reader.cancel()
})

test("eof, read errors, and consumer cancels are forwarded and reported exactly once", async () => {
  {
    const { completions, on } = collector()
    const observed = observeAuxiliaryResponse(new Response(byteStream(["done"])), on, () => BASE)
    await observed.response.text()
    assert.deepEqual(completions, [{ at: BASE, status: "completed" }])
  }
  {
    const { completions, on } = collector()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        controller.error(new Error("midstream failure"))
      },
    })
    const observed = observeAuxiliaryResponse(new Response(source), on, () => BASE + 1)
    const reader = observed.response.body!.getReader()
    // error() discards queued chunks, so the very first consumer read rejects.
    await assert.rejects(reader.read(), /midstream failure/)
    assert.deepEqual(completions, [{ at: BASE + 1, status: "error", message: "Error: midstream failure" }])
  }
  {
    const { completions, on } = collector()
    let cancelledReason: unknown
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
        controller.enqueue(new TextEncoder().encode("second"))
      },
      cancel(reason) {
        cancelledReason = reason
      },
    })
    const observed = observeAuxiliaryResponse(new Response(source), on, () => BASE + 2)
    const reader = observed.response.body!.getReader()
    await reader.read()
    await reader.cancel("consumer left")
    assert.equal(String(cancelledReason), "consumer left", "cancellation reason forwards to the provider reader")
    assert.deepEqual(completions, [{ at: BASE + 2, status: "cancelled" }])
  }
})

test("a throwing telemetry callback cannot affect delivery", async () => {
  let calls = 0
  const observed = observeAuxiliaryResponse(
    new Response(byteStream(["payload"])),
    () => {
      calls += 1
      throw new Error("telemetry bug")
    },
    () => BASE,
  )
  assert.equal(await observed.response.text(), "payload")
  assert.equal(calls, 1)
  observed.detach()
})

test("null bodies complete at arrival and return the original response", () => {
  const { completions, on } = collector()
  const original = new Response(null, { status: 204 })
  const observed = observeAuxiliaryResponse(original, on, () => BASE + 3)
  assert.equal(observed.response, original)
  assert.deepEqual(completions, [{ at: BASE + 3, status: "completed" }])
  observed.detach()
})

test("locked or already-used bodies return unchanged with unavailable", async () => {
  {
    const { completions, on } = collector()
    const original = new Response(byteStream(["x"]))
    original.body?.getReader() // lock the body from outside
    const observed = observeAuxiliaryResponse(original, on, () => BASE + 4)
    assert.equal(observed.response, original)
    assert.deepEqual(completions, [{ at: BASE + 4, status: "unavailable", message: "body already locked or consumed" }])
    observed.detach()
  }
  {
    const { completions, on } = collector()
    const original = new Response(byteStream(["y"]))
    await original.text() // consume the body first
    const observed = observeAuxiliaryResponse(original, on, () => BASE + 5)
    assert.equal(observed.response, original)
    assert.deepEqual(completions, [{ at: BASE + 5, status: "unavailable", message: "body already locked or consumed" }])
    observed.detach()
  }
})

test("opaque responses return unchanged with unavailable", () => {
  const { completions, on } = collector()
  const original = Response.error() // opaque: type "opaque", status 0, null body
  const observed = observeAuxiliaryResponse(original, on, () => BASE + 6)
  assert.equal(observed.response, original)
  assert.deepEqual(completions, [{ at: BASE + 6, status: "unavailable", message: "opaque or status-zero response" }])
  observed.detach()
})

test("detach disables telemetry only and leaves the provider body consumable", async () => {
  const { completions, on } = collector()
  const observed = observeAuxiliaryResponse(new Response(byteStream(["still ", "here"])), on, () => BASE + 7)
  observed.detach()
  assert.equal(await observed.response.text(), "still here", "body delivers normally after detach")
  assert.deepEqual(completions, [], "no telemetry after detach")
})
