/**
 * Operational commands (feature-012, ADR-0005): server-log-only status and a
 * standalone connectivity test. Commands never touch the tracker, never
 * drive a model API, and never change the host conversation. They report the
 * active configuration (ADR-0001: resolved once in setup) and retain the
 * last runtime error from the shared RuntimeStatus slot.
 */

import { applyCapturePolicy, type CapturePolicy, type PrivacyPreset } from "./capture-policy.js"
import { LANGFUSE_TEST_TIMEOUT_MS } from "./constants.js"
import { maskPublicKey, type CredentialConfig } from "./config.js"
import type { IngestEvent, LangfuseTransport } from "./langfuse.js"
import { redactHost, redactValue } from "./redaction.js"
import type { RuntimeStatus } from "./runtime-status.js"

export interface LangfuseCommandOptions {
  config: CredentialConfig
  policy: CapturePolicy
  preset: PrivacyPreset
  runtimeStatus: RuntimeStatus
  transport?: LangfuseTransport
  log?: (message: string) => void
  now?: () => number
  newId?: () => string
}

export interface LangfuseCommands {
  status(): Promise<void>
  test(): Promise<void>
  /** Marks the commands closed and aborts in-flight tests; unload path. */
  close(): void
}

const TEST_TRACE_NAME = "opencode-langfuse-test"
const FLAG_FIELDS = [
  "captureInputs",
  "captureOutputs",
  "captureToolIo",
  "captureSystemPrompt",
  "captureCwd",
] as const

export function createLangfuseCommands(options: LangfuseCommandOptions): LangfuseCommands {
  const log = options.log ?? ((message: string) => console.log(`📊 Langfuse: ${message}`))
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID())
  const { config, policy, preset, runtimeStatus, transport } = options

  let closed = false
  let inFlight: AbortController | undefined

  function statusLines(): string[] {
    const enabled = config.source !== "none"
    const lines: string[] = [`State: ${enabled ? "enabled" : "disabled"}`]
    lines.push(`Config source: ${config.source}`)
    lines.push(`Host: ${enabled ? redactHost(config.host) : "not configured"}`)
    lines.push(`Public key: ${enabled ? maskPublicKey(config.publicKey) : "not configured"}`)
    lines.push(`Privacy preset: ${preset}`)
    for (const field of FLAG_FIELDS) {
      lines.push(`${field}: ${policy[field] ? "on" : "off"}`)
    }
    const last = runtimeStatus.getLastError()
    lines.push(
      last
        ? `Last runtime error: [${last.scope}] ${last.message} at ${new Date(last.timestamp).toISOString()}`
        : "Last runtime error: none",
    )
    if (!enabled) {
      lines.push(`Reason: ${String(redactValue(config.reason))}`)
    }
    return lines
  }

  return {
    async status(): Promise<void> {
      if (closed) {
        return
      }
      log("Langfuse status:")
      for (const line of statusLines()) {
        log(`  ${line}`)
      }
    },

    async test(): Promise<void> {
      if (closed) {
        return
      }
      if (config.source === "none" || transport === undefined) {
        log(`Langfuse test unavailable: tracing is not configured (${String(redactValue(config.source === "none" ? config.reason : "no active transport"))})`)
        return
      }
      const emittedAt = now()
      const iso = new Date(emittedAt).toISOString()
      // A standalone trace/root per invocation: fresh ids, no session
      // grouping, no parent linkage, no scores.
      const traceId = newId().replaceAll("-", "")
      const rootId = newId().replaceAll("-", "").slice(0, 16)
      const captured = applyCapturePolicy(
        {
          input: { command: "/langfuse-test" },
          output: "ok",
          metadata: { source: "opencode-langfuse", command: "langfuse-test" },
        },
        policy,
      )
      const traceBody: Record<string, unknown> = {
        id: traceId,
        name: TEST_TRACE_NAME,
        timestamp: iso,
        metadata: captured.metadata,
      }
      if (captured.input !== undefined) {
        traceBody.input = captured.input
      }
      if (captured.output !== undefined) {
        traceBody.output = captured.output
      }
      const spanBody: Record<string, unknown> = {
        id: rootId,
        traceId,
        name: TEST_TRACE_NAME,
        level: "DEFAULT",
        startTime: iso,
        endTime: iso,
        metadata: captured.metadata,
      }
      if (captured.input !== undefined) {
        spanBody.input = captured.input
      }
      if (captured.output !== undefined) {
        spanBody.output = captured.output
      }
      const events: IngestEvent[] = [
        { id: newId(), type: "trace-create", timestamp: iso, body: traceBody },
        { id: newId(), type: "span-create", timestamp: iso, body: spanBody },
      ]

      // One bounded ingestion with the existing retry/abort behavior: an
      // overall deadline combined with unload cancellation.
      const controller = new AbortController()
      inFlight = controller
      const deadline = AbortSignal.timeout(LANGFUSE_TEST_TIMEOUT_MS)
      const signal = AbortSignal.any([deadline, controller.signal])
      try {
        const result = await transport.ingest(events, { signal })
        if (closed) {
          return
        }
        if (result.accepted === events.length && result.failed === 0) {
          log(`Langfuse test succeeded; traceId=${traceId} (host ${redactHost(config.host)})`)
        } else {
          const timedOut = deadline.aborted && !controller.signal.aborted
          const message = `Langfuse test failed: accepted ${result.accepted}/${events.length} event(s) (host ${redactHost(config.host)})${timedOut ? " after the 15s deadline" : ""}`
          log(message)
          runtimeStatus.record("langfuse-test", message)
        }
      } catch (error) {
        if (closed) {
          return
        }
        const message = `Langfuse test failed: ${String(redactValue(error instanceof Error ? error.message : String(error)))} (host ${redactHost(config.host)})`
        log(message)
        runtimeStatus.record("langfuse-test", message)
      } finally {
        if (inFlight === controller) {
          inFlight = undefined
        }
      }
    },

    close(): void {
      closed = true
      inFlight?.abort()
      inFlight = undefined
    },
  }
}
