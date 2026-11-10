import { Plugin } from "@opencode/plugin"
import { isAbsolute } from "node:path"
import { createCapturePolicy, resolvePrivacyPreset } from "./capture-policy.js"
import { createLangfuseCommands } from "./commands.js"
import { MAX_STRING_LENGTH } from "./constants.js"
import { loadConfig, maskPublicKey } from "./config.js"
import { createLangfuseTransport } from "./langfuse.js"
import { createPricingResolver } from "./pricing.js"
import { redactHost, redactValue } from "./redaction.js"
import { createRuntimeStatus } from "./runtime-status.js"
import { collectSourceMetadata } from "./source-metadata.js"
import { createTracker, type AssistantSnapshot, type SessionSnapshot, type ToolSnapshot } from "./tracker.js"
import type { ModelReference } from "./generations.js"
import { isRecord } from "./guards.js"
import { nativeExit, toolOutputText } from "./tools.js"
import type { ScoreSeedTool } from "./scores.js"

const SUBSCRIBED_EVENT_TYPES = [
  "session.created",
  "session.inbox.enqueued",
  "session.text.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
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
  // The session's own location (nonempty absolute only); never substituted.
  const location = info.location
  if (
    isRecord(location) &&
    typeof location.directory === "string" &&
    location.directory.length > 0 &&
    isAbsolute(location.directory)
  ) {
    snapshot.directory = location.directory
  }
  if (!Array.isArray(context)) {
    // A transcript read failure is not a complete empty history; scores stay
    // omitted while the known info still reconciles identity and directory.
    snapshot.scoreHistory = { complete: false }
    return snapshot
  }
  const messages = context
  // Score history seeding: identities and terminal outcomes only. A completed
  // compaction boundary means the window lost its prefix — incomplete, never
  // invented. Streaming-only tool parts are not admitted calls and are skipped.
  let completedCompaction = false
  let malformed = false
  const turns: string[] = []
  const tools: ScoreSeedTool[] = []
  for (const message of messages) {
    if (!isRecord(message)) {
      malformed = true
      continue
    }
    if (message.type === "compaction") {
      if (message.status === "completed") {
        completedCompaction = true
      }
      continue
    }
    if (message.type === "assistant" && typeof message.id === "string" && message.id.length > 0) {
      turns.push(message.id)
      const content = Array.isArray(message.content) ? message.content : []
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool") {
          continue
        }
        if (typeof part.id !== "string" || part.id.length === 0 || typeof part.name !== "string" || part.name.length === 0) {
          malformed = true
          continue
        }
        const state = isRecord(part.state) ? part.state : undefined
        const status = state?.status
        if (status === "streaming") {
          continue
        }
        if (status !== "running" && status !== "completed" && status !== "error") {
          malformed = true
          continue
        }
        const tool: {
          assistantMessageID: string
          toolCallID: string
          name: string
          status: "running" | "completed" | "error"
          exit?: number
        } = { assistantMessageID: message.id, toolCallID: part.id, name: part.name, status }
        const exit = nativeExit(isRecord(state?.metadata) ? state.metadata.exit : undefined)
        if (exit !== undefined) {
          tool.exit = exit
        }
        tools.push(tool)
      }
    }
  }
  snapshot.scoreHistory =
    completedCompaction || malformed ? { complete: false } : { complete: true, turns, tools }
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

/**
 * The exact matching assistant tool part only (feature-006): never borrows
 * another call's identity. Maps finite `time.ran ?? time.created` /
 * `time.completed` and `state.metadata.exit`; output follows the same
 * textual-content rule as live capture.
 */
function parseToolSnapshot(message: unknown, assistantMessageID: string, toolCallID: string): ToolSnapshot | undefined {
  if (!isRecord(message) || message.id !== assistantMessageID || message.type !== "assistant" || !Array.isArray(message.content)) {
    return undefined
  }
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "tool" || part.id !== toolCallID) {
      continue
    }
    if (typeof part.name !== "string" || part.name.length === 0) {
      return undefined
    }
    const time = isRecord(part.time) ? part.time : undefined
    const ranAt = typeof time?.ran === "number" && Number.isFinite(time.ran) ? time.ran : undefined
    const createdAt = typeof time?.created === "number" && Number.isFinite(time.created) ? time.created : undefined
    const completedAt = typeof time?.completed === "number" && Number.isFinite(time.completed) ? time.completed : undefined
    const state = isRecord(part.state) ? part.state : undefined
    const stateStatus = state?.status
    const snapshot: ToolSnapshot = {
      name: part.name,
      status: stateStatus === "completed" || stateStatus === "error" ? stateStatus : "running",
      startedAt: ranAt ?? createdAt,
    }
    if (completedAt !== undefined) {
      snapshot.completedAt = completedAt
    }
    if (state?.input !== undefined) {
      snapshot.input = state.input
    }
    const output = toolOutputText(state?.content)
    if (output !== undefined) {
      snapshot.output = output
    }
    const exit = nativeExit(isRecord(state?.metadata) ? state.metadata.exit : undefined)
    if (exit !== undefined) {
      snapshot.exit = exit
    }
    if (isRecord(state?.error) && typeof state.error.message === "string" && state.error.message.length > 0) {
      snapshot.errorMessage = boundedText(state.error.message)
    }
    return snapshot
  }
  return undefined
}

export default Plugin.define({
  id: "opencode-langfuse",
  async setup(ctx) {
    const config = await loadConfig()
    // Active configuration (ADR-0001) is resolved once: the commands report
    // and test exactly what the tracker uses, never a freshly reread file.
    const runtimeStatus = createRuntimeStatus()
    const filePreset = config.source === "none" ? undefined : config.privacyPreset
    const preset = resolvePrivacyPreset({ preset: filePreset })
    const policy = createCapturePolicy({ preset: filePreset })
    // Setup-local stopping flag: after unload begins, no observer may replace
    // the retained last-error state behind closed commands.
    let stopping = false
    const recordError = (scope: string) => (message: string) => {
      if (!stopping) {
        runtimeStatus.record(scope, message)
      }
    }

    const transport =
      config.source === "none"
        ? undefined
        : createLangfuseTransport(
            {
              host: config.host,
              publicKey: config.publicKey,
              secretKey: config.secretKey,
            },
            { onError: recordError("ingestion") },
          )

    const commands = createLangfuseCommands({
      config,
      policy,
      preset,
      runtimeStatus,
      transport,
      log: (message) => console.log(`📊 Langfuse: ${message}`),
    })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "langfuse-status",
        description: "Show active Langfuse tracing status (server logs)",
        execute: () => commands.status(),
      })
      editor.add({
        name: "langfuse-test",
        description: "Send a standalone Langfuse connectivity test trace (server logs)",
        execute: () => commands.test(),
      })
    })

    if (config.source === "none" || transport === undefined) {
      const reason = config.source === "none" ? config.reason : "transport unavailable"
      console.log(`📊 Langfuse: Disabled — ${reason}`)
      return () => {
        stopping = true
        commands.close()
      }
    }
    console.log(
      `📊 Langfuse: Tracing enabled → ${redactHost(config.host)} (key ${maskPublicKey(config.publicKey)}, source ${config.source})`,
    )

    // The unload controller must exist before tracker/collector construction:
    // source-metadata collection takes the plugin's abort signal, and the
    // event subscription below reuses the same controller.
    const controller = new AbortController()
    const tracker = createTracker({
      transport,
      policy,
      // One resolver for the plugin lifetime: file pricing overrides (env
      // selection never carries pricing) plus the native catalog loader. The
      // catalog is loaded lazily on the first lookup without an exact
      // override, i.e. after hooks and subscription are installed.
      pricing: createPricingResolver({
        overrides: config.pricing,
        loadCatalog: () => ctx.model.list(),
      }),
      onError: recordError("tracker"),
      lookupSession: async (sessionID) => {
        // Direct result shapes (verified by the identity preflight); no guessed
        // envelopes are ported.
        const info: unknown = await ctx.session.get({ sessionID })
        let context: unknown
        try {
          context = await ctx.session.context({ sessionID })
        } catch (error) {
          // A failed transcript read must not discard the known info:
          // identity (and directory) survive with omitted scores.
          console.warn(
            `📊 Langfuse: ${String(
              redactValue(truncateDiagnostic(`failed transcript context for session ${sessionID}: ${String(error)}`)),
            )}`,
          )
        }
        return parseSessionSnapshot(info, context)
      },
      lookupSourceMetadata: (directory) =>
        collectSourceMetadata(directory, {
          readVcs: (dir, signal) => ctx.vcs.get({ location: { directory: dir } }, { signal }),
          signal: controller.signal,
          log: (message) => {
            console.warn(`📊 Langfuse: ${message}`)
            recordError("source-metadata")(message)
          },
        }),
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
      lookupTool: async (sessionID, assistantMessageID, toolCallID) => {
        const context: unknown = await ctx.session.context({ sessionID })
        if (!Array.isArray(context)) {
          return undefined
        }
        for (const message of context) {
          const snapshot = parseToolSnapshot(message, assistantMessageID, toolCallID)
          if (snapshot) {
            return snapshot
          }
        }
        return undefined
      },
    })

    // Read-only tool outcome hook (feature-006): awaited registration, before
    // the event subscription. handleToolAfter captures synchronously and never
    // awaits session work, so provider delivery is never delayed here.
    await ctx.tool.hook("execute.after", (event) => {
      tracker.handleToolAfter(event)
    })

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
            recordError("event")(truncateDiagnostic(error))
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          // The stream is a boundary: dynamic error text passes the redactor
          // like every other emitted string, never raw.
          console.warn(`📊 Langfuse: Event stream failed: ${String(redactValue(truncateDiagnostic(error)))}`)
          recordError("event-stream")(truncateDiagnostic(error))
        }
      }
    })()

    return async () => {
      stopping = true
      commands.close()
      controller.abort()
      await tracker.shutdown()
    }
  },
})

function truncateDiagnostic(error: unknown): string {
  const message = String(error)
  return message.length > 300 ? `${message.slice(0, 300)}... [truncated]` : message
}
