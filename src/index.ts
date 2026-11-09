import { Plugin } from "@opencode/plugin"
import { createCapturePolicy } from "./capture-policy.js"
import { loadConfig, maskPublicKey } from "./config.js"
import { isRecord } from "./guards.js"
import { createLangfuseTransport } from "./langfuse.js"
import { createTracker, type TracingEvent } from "./tracker.js"

const SUBSCRIBED_EVENT_TYPES = [
  "session.created",
  "session.inbox.enqueued",
  "session.text.ended",
  "session.execution.succeeded",
] as const

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
      lookupParentID: async (sessionId) => {
        const result: unknown = await ctx.session.get({ sessionID: sessionId })
        if (!isRecord(result)) {
          return undefined
        }
        const data = isRecord(result.data) ? result.data : result
        const parentID = data.parentID
        return typeof parentID === "string" && parentID.length > 0 ? parentID : undefined
      },
    })
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const streamed of ctx.event.subscribe({
          types: [...SUBSCRIBED_EVENT_TYPES],
          signal: controller.signal,
        })) {
          // The event stream is a boundary: parse defensively into TracingEvent.
          const event: unknown = streamed
          if (!isRecord(event) || typeof event.type !== "string") {
            continue
          }
          const tracingEvent: TracingEvent = {
            type: event.type,
            created: typeof event.created === "number" ? event.created : undefined,
            data: event.data,
          }
          tracker.handleEvent(tracingEvent)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`📊 Langfuse: Event stream failed: ${String(error)}`)
        }
      }
    })()

    return async () => {
      controller.abort()
      await tracker.flushAll()
    }
  },
})
