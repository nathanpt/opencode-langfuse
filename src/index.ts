import { Plugin } from "@opencode/plugin"
import { createCapturePolicy } from "./capture-policy.js"
import { MAX_STRING_LENGTH } from "./constants.js"
import { loadConfig, maskPublicKey } from "./config.js"
import { createLangfuseTransport } from "./langfuse.js"
import { redactValue } from "./redaction.js"
import { createTracker, type AssistantSnapshot, type SessionSnapshot } from "./tracker.js"
import type { ModelReference } from "./generations.js"
import { isRecord } from "./guards.js"

const SUBSCRIBED_EVENT_TYPES = [
  "session.created",
  "session.inbox.enqueued",
  "session.text.ended",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
] as const

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? redactValue(value.slice(0, MAX_STRING_LENGTH)) as string
    : undefined
}

function parseModelRef(value: unknown): ModelReference | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const id = value.id
  const providerID = value.providerID
  if (typeof id !== "string" || id.length === 0 || typeof providerID !== "string" || providerID.length === 0) {
    return undefined
  }
  const variant = value.variant
  return {
    id,
    providerID,
    variant: typeof variant === "string" && variant.length > 0 ? variant : undefined,
  }
}

/** Assistant text parts only — never reasoning, tool, system, or native payloads. */
function assistantText(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "assistant" || !Array.isArray(value.content)) {
    return undefined
  }
  const parts: string[] = []
  for (const part of value.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      parts.push(part.text)
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined
}

/** User message text only (direct `text` field on the transcript user message). */
function userText(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "user") {
    return undefined
  }
  return boundedText(value.text)
}

function parseSessionSnapshot(info: unknown, context: unknown): SessionSnapshot | undefined {
  if (!isRecord(info)) {
    return undefined
  }
  const snapshot: SessionSnapshot = {}
  const parentID = info.parentID
  if (typeof parentID === "string" && parentID.length > 0) {
    snapshot.parentID = parentID
  }
  const time = info.time
  if (isRecord(time) && typeof time.created === "number" && Number.isFinite(time.created)) {
    snapshot.createdAt = time.created
  }
  const messages = Array.isArray(context) ? context : []
  for (const message of messages) {
    if (!isRecord(message)) {
      continue
    }
    const prompt = userText(message)
    if (prompt !== undefined && snapshot.firstPrompt === undefined) {
      snapshot.firstPrompt = prompt
    }
    const output = assistantText(message)
    if (output !== undefined) {
      snapshot.latestAssistantOutput = output
    }
  }
  return snapshot
}

function parseAssistantSnapshot(message: unknown, assistantMessageID: string): AssistantSnapshot | undefined {
  if (!isRecord(message) || message.id !== assistantMessageID || message.type !== "assistant") {
    return undefined
  }
  const model = parseModelRef(message.model)
  const time = isRecord(message.time) ? message.time : undefined
  const createdAt = time?.created
  if (model === undefined || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined
  }
  const agent = message.agent
  const snapshot: AssistantSnapshot = {
    id: assistantMessageID,
    agent: typeof agent === "string" ? agent : "unknown",
    model,
    createdAt,
  }
  if (typeof time?.streamed === "number" && Number.isFinite(time.streamed)) {
    snapshot.streamedAt = time.streamed
  }
  if (typeof time?.completed === "number" && Number.isFinite(time.completed)) {
    snapshot.completedAt = time.completed
  }
  if (typeof message.finish === "string") {
    snapshot.finish = message.finish
  }
  const error = message.error
  if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) {
    snapshot.errorMessage = boundedText(error.message)
  }
  return snapshot
}

export default Plugin.define({
  id: "opencode-langfuse",
  async setup(ctx) {
    const config = await loadConfig()
    if (config.source === "none") {
      console.log(`📊 Langfuse: Disabled — ${config.reason}`)
      return
    }
    console.log(
      `📊 Langfuse: Tracing enabled → ${config.host} (key ${maskPublicKey(config.publicKey)}, source ${config.source})`,
    )

    const transport = createLangfuseTransport({
      host: config.host,
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    })
    const tracker = createTracker({
      transport,
      policy: createCapturePolicy({ preset: config.privacyPreset }),
      lookupSession: async (sessionID) => {
        // Direct result shapes (verified by the identity preflight); no guessed
        // envelopes are ported.
        const info: unknown = await ctx.session.get({ sessionID })
        const context: unknown = await ctx.session.context({ sessionID })
        return parseSessionSnapshot(info, context)
      },
      lookupAssistant: async (sessionID, assistantMessageID) => {
        const context: unknown = await ctx.session.context({ sessionID })
        if (!Array.isArray(context)) {
          return undefined
        }
        for (const message of context) {
          const snapshot = parseAssistantSnapshot(message, assistantMessageID)
          if (snapshot) {
            return snapshot
          }
        }
        return undefined
      },
    })
    const controller = new AbortController()

    // Awaited native HTTP hooks (registration returns a promise). Primary
    // exchanges are acquired from durable step identity, never from traffic.
    await ctx.session.hook("http.request", async (input) => {
      if (input.kind === "primary") {
        return
      }
      const model = parseModelRef(input.model)
      if (model === undefined) {
        return
      }
      tracker.startAuxiliary({
        sessionID: input.sessionID,
        agent: input.agent,
        model,
        kind: input.kind,
        request: input.request,
      })
    })

    await ctx.session.hook("http.response", async (input) => {
      if (input.kind === "primary") {
        return
      }
      const model = parseModelRef(input.model)
      if (model === undefined) {
        return
      }
      input.response = tracker.observeAuxiliaryResponse({
        sessionID: input.sessionID,
        agent: input.agent,
        model,
        kind: input.kind,
        request: input.request,
        response: input.response,
      })
    })

    void (async () => {
      try {
        for await (const streamed of ctx.event.subscribe({
          types: [...SUBSCRIBED_EVENT_TYPES],
          signal: controller.signal,
        })) {
          // The event stream is a boundary: the tracker parses the native
          // envelope once. Per-session chains absorb the work; this loop never
          // waits on a session's state or on Langfuse.
          void tracker.handleEvent(streamed).catch((error) => {
            console.warn(`📊 Langfuse: ${String(redactValue(truncateDiagnostic(error)))}`)
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`📊 Langfuse: Event stream failed: ${String(error)}`)
        }
      }
    })()

    return async () => {
      controller.abort()
      await tracker.shutdown()
    }
  },
})

function truncateDiagnostic(error: unknown): string {
  const message = String(error)
  return message.length > 300 ? `${message.slice(0, 300)}... [truncated]` : message
}
