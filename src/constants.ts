/** Shared limits and defaults for payload shaping and the transport. */

export const MAX_STRING_LENGTH = 12_000
export const MAX_DEPTH = 6
export const MAX_ARRAY_ITEMS = 50
export const MAX_OBJECT_KEYS = 80

/** Name for the per-session trace and its root observation. */
export const TRACE_NAME = "opencode-agent"

/** Langfuse session ids are capped at 200 chars server-side. */
export const LANGFUSE_SESSION_ID_MAX = 200

/** Grace window after `session.execution.succeeded` before flushing a session's payload. */
export const FLUSH_GRACE_MS = 1_500

/** Per-attempt ingestion POST timeout. */
export const INGEST_TIMEOUT_MS = 10_000

/** Bounded cap for the final shutdown flush. */
export const SHUTDOWN_TIMEOUT_MS = 5_000

export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"
