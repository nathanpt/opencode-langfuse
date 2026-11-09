import assert from "node:assert/strict"
import { test } from "node:test"
import { applyCapturePolicy, createCapturePolicy } from "../src/capture-policy.js"

const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>

test("preset table matches the documented privacy tiers", () => {
  assert.deepEqual(createCapturePolicy({ preset: "metadata-only", env: FULL_ENV }), {
    captureInputs: false,
    captureOutputs: false,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
  })
  assert.equal(createCapturePolicy({ preset: "conversations", env: FULL_ENV }).captureOutputs, true)
  assert.equal(createCapturePolicy({ preset: "prompts-only", env: FULL_ENV }).captureOutputs, false)
  assert.equal(createCapturePolicy({ preset: "full-debug", env: FULL_ENV }).captureToolIo, true)
})

test("unknown preset falls back to full-debug", () => {
  assert.equal(createCapturePolicy({ preset: "nonsense", env: FULL_ENV }).captureInputs, true)
  assert.equal(createCapturePolicy({ env: FULL_ENV }).captureInputs, true)
})

test("env preset overrides the file preset", () => {
  const policy = createCapturePolicy({ preset: "conversations", env: { ...FULL_ENV, LANGFUSE_PRIVACY_PRESET: "metadata-only" } })
  assert.equal(policy.captureInputs, false)
})

test("env field flags override the preset", () => {
  const policy = createCapturePolicy({
    preset: "metadata-only",
    env: { ...FULL_ENV, LANGFUSE_CAPTURE_OUTPUTS: "1", LANGFUSE_CAPTURE_CWD: "true" },
  })
  assert.equal(policy.captureInputs, false)
  assert.equal(policy.captureOutputs, true)
  assert.equal(policy.captureCwd, true)
})

test("gated fields are dropped, allowed fields are redacted", () => {
  const policy = createCapturePolicy({ preset: "conversations", env: FULL_ENV })
  const captured = applyCapturePolicy(
    {
      input: "user prompt",
      output: "assistant answer",
      toolInput: "tool payload",
      metadata: { cwd: "/home/nathan/project", sessionId: "ses_1" },
    },
    policy,
  )
  assert.equal(captured.input, "user prompt")
  assert.equal(captured.output, "assistant answer")
  assert.equal(captured.toolInput, undefined)
  assert.deepEqual(captured.metadata, { sessionId: "ses_1" })
})
