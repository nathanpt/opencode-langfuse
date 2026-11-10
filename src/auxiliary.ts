/**
 * Response-lifetime observation for auxiliary model exchanges.
 *
 * A pass-through ReadableStream (highWaterMark 0) forwards provider bytes on
 * consumer demand only, classifies the terminal boundary (EOF / read error /
 * consumer cancel), and never decodes, accumulates, or races the real reader.
 * There is no production response-lifetime observer to reuse, so this module
 * is self-contained: callback failures must never change provider bytes,
 * cancellation, or delivery.
 */

export interface AuxiliaryCompletion {
  at: number
  status: "completed" | "error" | "cancelled" | "unavailable"
  message?: string
}

export interface ObservedAuxiliaryResponse {
  response: Response
  /** Disables telemetry callbacks only; never touches a body still being consumed. */
  detach(): void
}

export function observeAuxiliaryResponse(
  response: Response,
  onComplete: (completion: AuxiliaryCompletion) => void,
  now: () => number = Date.now,
): ObservedAuxiliaryResponse {
  const noopDetach = (): void => {}

  function report(completion: AuxiliaryCompletion, detachedRef: { value: boolean }): void {
    if (detachedRef.value) {
      return
    }
    try {
      onComplete(completion)
    } catch {
      // Callback errors cannot affect provider bytes, cancellation, or delivery.
    }
  }

  // Unsupported opaque or status-zero responses: no body contract to observe.
  if (response.type === "opaque" || response.status === 0) {
    onComplete({ at: now(), status: "unavailable", message: "opaque or status-zero response" })
    return { response, detach: noopDetach }
  }

  let body: ReadableStream<Uint8Array>
  try {
    body = response.body as ReadableStream<Uint8Array> | null as ReadableStream<Uint8Array>
  } catch {
    body = null as unknown as ReadableStream<Uint8Array>
  }
  if (!body) {
    // Null body: the exchange completes at response arrival; return the original.
    onComplete({ at: now(), status: "completed" })
    return { response, detach: noopDetach }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    // Already-used or locked body: return it unchanged rather than breaking the host.
    onComplete({ at: now(), status: "unavailable", message: "body already locked or consumed" })
    return { response, detach: noopDetach }
  }

  const detachedRef = { value: false }
  let reported = false

  function reportOnce(completion: AuxiliaryCompletion): void {
    if (reported) {
      return
    }
    reported = true
    report(completion, detachedRef)
  }

  const tracked = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            // Release at the natural terminal boundary, not at detach/unload.
            try {
              reader.releaseLock()
            } catch {}
            reportOnce({ at: now(), status: "completed" })
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch (error) {
          try {
            reader.releaseLock()
          } catch {}
          reportOnce({ at: now(), status: "error", message: String(error) })
          controller.error(error)
        }
      },
      cancel(reason) {
        const forward = reader.cancel(reason)
        void forward
          .catch(() => {})
          .finally(() => {
            try {
              reader.releaseLock()
            } catch {}
          })
        reportOnce({ at: now(), status: "cancelled" })
        return forward
      },
    },
    { highWaterMark: 0 },
  )

  let replacement: Response
  try {
    replacement = new Response(tracked, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    // A caller's clone() must see the same metadata values.
    Object.defineProperty(replacement, "url", { value: response.url, configurable: true })
    Object.defineProperty(replacement, "redirected", { value: response.redirected, configurable: true })
    Object.defineProperty(replacement, "type", { value: response.type, configurable: true })
  } catch (error) {
    // Wrapper construction failed before consumption started: no bytes were
    // read, so releasing the lock hands the undisturbed body back to the host.
    try {
      reader.releaseLock()
    } catch {}
    onComplete({ at: now(), status: "unavailable", message: String(error) })
    return { response, detach: noopDetach }
  }

  return {
    response: replacement,
    detach() {
      detachedRef.value = true
    },
  }
}
