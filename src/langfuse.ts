/**
 * Langfuse REST ingestion transport.
 *
 * Deliberately REST-only (no OTel SDK): the plugin builds each payload
 * explicitly, so per-event acceptance from `POST /api/public/ingestion`
 * replaces the SDK's opaque queue, and the sibling's OTel setup plus
 * REST-fallback path collapses into one deterministic request path.
 */

import { INGEST_TIMEOUT_MS } from "./constants.js"
import { isRecord } from "./guards.js"

export interface LangfuseEndpointConfig {
  host: string
  publicKey: string
  secretKey: string
}

export interface IngestEvent {
  id: string
  type: string
  timestamp: string
  body: Record<string, unknown>
}

export interface IngestResult {
  accepted: number
  failed: number
}

export interface IngestOptions {
  /** External cancellation (shutdown deadline); stops retrying immediately. */
  signal?: AbortSignal
}

export interface LangfuseTransport {
  ingest(events: IngestEvent[], options?: IngestOptions): Promise<IngestResult>
}

export interface TransportOptions {
  timeoutMs?: number
  attempts?: number
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

interface IngestionError {
  id?: string
  status?: number
  message?: string
}

export function createLangfuseTransport(config: LangfuseEndpointConfig, options: TransportOptions = {}): LangfuseTransport {
  const timeoutMs = options.timeoutMs ?? INGEST_TIMEOUT_MS
  const attempts = Math.max(1, options.attempts ?? 2)
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((message: string) => console.warn(`📊 Langfuse: ${message}`))
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`

  async function attempt(events: IngestEvent[], signal: AbortSignal | undefined): Promise<IngestResult> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetchImpl(`${config.host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: { sdk_name: "opencode-langfuse" },
        batch: events,
      }),
      signal: combined,
    })

    if (!response.ok) {
      throw new Error(`ingestion responded ${response.status}`)
    }

    // 200 = all accepted; 207 = per-event outcomes in `errors`.
    if (response.status === 207) {
      const payload: unknown = await response.json()
      const rawErrors = isRecord(payload) && Array.isArray(payload.errors) ? payload.errors : []
      const errors = rawErrors.filter(isRecord) as IngestionError[]
      return { accepted: events.length - errors.length, failed: errors.length }
    }
    return { accepted: events.length, failed: 0 }
  }

  return {
    async ingest(events: IngestEvent[], options?: IngestOptions): Promise<IngestResult> {
      if (events.length === 0) {
        return { accepted: 0, failed: 0 }
      }

      let lastError: unknown
      for (let i = 0; i < attempts; i += 1) {
        if (options?.signal?.aborted) {
          break
        }
        try {
          return await attempt(events, options?.signal)
        } catch (error) {
          lastError = error
          if (options?.signal?.aborted) {
            break
          }
        }
      }
      log(`Failed to ingest ${events.length} event(s) to ${config.host}: ${String(lastError)}`)
      return { accepted: 0, failed: events.length }
    },
  }
}
