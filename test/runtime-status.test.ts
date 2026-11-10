/**
 * RuntimeStatus (feature-012, ADR-0005): one plugin-instance-local last-error
 * slot; message-only extraction, redaction, bounding, and retention until the
 * next failure or reload.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { createRuntimeStatus } from "../src/runtime-status.js"

test("records the Error message only, never the stack", () => {
  const status = createRuntimeStatus(() => 1_000)
  const error = new Error("ingestion failed")
  status.record("ingestion", error)
  const last = status.getLastError()
  assert.ok(last)
  assert.equal(last.message, "ingestion failed")
  assert.ok(!last.message.includes("at "))
  assert.equal(last.scope, "ingestion")
  assert.equal(last.timestamp, 1_000)
})

test("redacts secrets and bounds the message to 300 characters", () => {
  const status = createRuntimeStatus(() => 1)
  status.record("event", "leak sk-ant-feature069-canary tail")
  const first = status.getLastError()
  assert.ok(first?.message.includes("[REDACTED_SECRET]"))
  assert.ok(!JSON.stringify(first).includes("sk-ant-feature069-canary"))

  const long = `x`.repeat(500)
  status.record("tracker", long)
  const last = status.getLastError()
  assert.ok(last?.message.startsWith("x"))
  assert.ok((last?.message.length ?? 0) <= 400, "bounded message plus the truncation marker stays small")
  assert.ok(last?.message.includes("... [truncated]"))
})

test("retains the last failure across successes and replaces it with the next failure", () => {
  let time = 0
  const status = createRuntimeStatus(() => time)
  status.record("ingestion", new Error("first failure"))
  time = 10
  status.record("langfuse-test", "not-an-error-success-marker")
  // A later successful read does not clear the slot: only record() replaces.
  assert.equal(status.getLastError()?.message, "not-an-error-success-marker")
  time = 20
  status.record("event", new Error("second failure"))
  const last = status.getLastError()
  assert.equal(last?.message, "second failure")
  assert.equal(last?.scope, "event")
  assert.equal(last?.timestamp, 20)
})

test("empty messages are never recorded and instances are isolated", () => {
  const a = createRuntimeStatus(() => 1)
  const b = createRuntimeStatus(() => 2)
  a.record("ingestion", "")
  assert.equal(a.getLastError(), undefined)
  a.record("ingestion", new Error("only in a"))
  assert.equal(b.getLastError(), undefined)
  assert.equal(a.getLastError()?.scope, "ingestion")
})

test("non-Error values stringify through the redactor and records are immutable", () => {
  const status = createRuntimeStatus(() => 5)
  status.record("source-metadata", "Source metadata unavailable")
  const last = status.getLastError()
  assert.ok(last)
  assert.equal(last.message, "Source metadata unavailable")
  assert.equal(last.timestamp, 5)
  assert.equal(Object.isFrozen(last), true)
  assert.throws(() => {
    ;(last as { scope: string }).scope = "mutated"
  })
})
