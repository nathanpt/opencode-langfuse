/** Shared limits and defaults for payload shaping and the transport. */

export const MAX_STRING_LENGTH = 12_000
export const MAX_DEPTH = 6
export const MAX_ARRAY_ITEMS = 50
export const MAX_OBJECT_KEYS = 80

/** Name for the per-session trace and its root observation. */
export const TRACE_NAME = "opencode-agent"

/** Name for the primary agent-loop generation observation. Auxiliary kinds append `:<kind>`. */
export const GENERATION_NAME = "llm-generation"

/** Langfuse session ids are capped at 200 chars server-side. */
export const LANGFUSE_SESSION_ID_MAX = 200

/** Grace window after the first dirty change before an export batch is posted. */
export const FLUSH_GRACE_MS = 1_500

/** Per-attempt ingestion POST timeout. */
export const INGEST_TIMEOUT_MS = 10_000

/** Rates are USD per 1,000,000 tokens; computed cost amounts are USD. */
export const PRICE_PER_MILLION = 1_000_000

/** Bounded cap for the final shutdown flush. */
export const SHUTDOWN_TIMEOUT_MS = 5_000

/** Maximum retained session records; overflow evicts the LRU clean inactive record. */
export const MAX_TRACKED_SESSIONS = 256

/** Maximum admitted, not-yet-settled/exported generations per session; overflow refuses telemetry. */
export const MAX_PENDING_GENERATIONS_PER_SESSION = 256

/**
 * Deterministic identity seeds. Trace and root observation ids are derived from the
 * OpenCode session id alone, so a continued or reconstructed session reuses them. No
 * credentials or filesystem paths may enter these seeds.
 */
export const TRACE_SEED_PREFIX = "opencode-langfuse:trace:"
export const ROOT_SEED_PREFIX = "opencode-langfuse:root:"
export const GENERATION_SEED_PREFIX = "opencode-langfuse:generation:"

export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"
