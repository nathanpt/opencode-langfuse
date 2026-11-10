/**
 * Plugin-instance-local runtime error retention (feature-012, ADR-0005):
 * exactly one last-error slot per instance, following the sibling's
 * convention — the last failure survives later successes until another
 * failure or plugin reload.
 */

import { redactValue } from "./redaction.js"

export interface RuntimeError {
  readonly scope: string
  readonly message: string
  readonly timestamp: number
}

export interface RuntimeStatus {
  record(scope: string, error: unknown): void
  getLastError(): RuntimeError | undefined
}

const MAX_ERROR_MESSAGE_LENGTH = 300

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value
}

/** Message text only — never an Error stack or a native payload. */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  return String(redactValue(error))
}

export function createRuntimeStatus(now: () => number = Date.now): RuntimeStatus {
  let last: RuntimeError | undefined
  return {
    record(scope: string, error: unknown): void {
      const raw = messageOf(error)
      if (raw.length === 0) {
        return
      }
      const message = truncate(String(redactValue(raw)), MAX_ERROR_MESSAGE_LENGTH)
      last = Object.freeze({ scope, message, timestamp: now() })
    },
    getLastError(): RuntimeError | undefined {
      return last
    },
  }
}
