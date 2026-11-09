import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_REDACT_OPTIONS, hashPath, redactString, redactValue } from "../src/redaction.js"

test("redacts bearer tokens", () => {
  const out = redactString("auth: Bearer abcdef1234567890abcd")
  assert.match(out, /\[REDACTED_SECRET\]/)
  assert.ok(!out.includes("abcdef1234567890abcd"))
})

test("redacts known token formats", () => {
  for (const secret of ["sk-lf-abc123", "pk-lf-abc123", "ghp_" + "a".repeat(30), "AKIA" + "B".repeat(16)]) {
    const out = redactString(`token ${secret}`)
    assert.ok(out.includes("[REDACTED_SECRET]"), secret)
    assert.ok(!out.includes(secret))
  }
})

test("redacts KEY=VALUE secret assignments", () => {
  const out = redactString("OPENAI_API_KEY=sk-supersecret123")
  assert.ok(out.includes("OPENAI_API_KEY=[REDACTED_SECRET]"))
  assert.ok(!out.includes("sk-supersecret123"))
})

test("redacts sensitive field values in objects", () => {
  const out = redactValue({ apiKey: "secret-value", name: "keep" }) as Record<string, unknown>
  assert.equal(out.apiKey, "[REDACTED_SECRET]")
  assert.equal(out.name, "keep")
})

test("hashes absolute home paths but preserves .env suffix", () => {
  const out = redactString("see /home/nathan/secrets/.env.production for keys")
  assert.ok(out.includes(`${hashPath("/home/nathan/secrets")}/.env.production`))
  assert.ok(!out.includes("nathan"))
})

test("truncates long strings with a marker", () => {
  const out = redactString("a".repeat(DEFAULT_REDACT_OPTIONS.maxStringLength + 10))
  assert.ok(out.endsWith("... [truncated]"))
})

test("bounds depth and array length", () => {
  const deep = { a: { a: { a: { a: { a: { a: { a: { a: { a: { value: "deep" } } } } } } } } } }
  const out = redactValue(deep) as Record<string, unknown>
  assert.ok(JSON.stringify(out).includes("max depth"))

  const long = Array.from({ length: 60 }, (_, i) => `item-${i}`)
  const array = redactValue(long) as unknown[]
  assert.equal(array.length, 51)
  assert.equal(array[50], "[10 truncated items]")
})

test("handles circular references", () => {
  const circular: Record<string, unknown> = { name: "root" }
  circular.self = circular
  const out = redactValue(circular) as Record<string, unknown>
  assert.equal(out.self, "[circular]")
})
