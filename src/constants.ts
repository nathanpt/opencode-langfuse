/** Shared limits and defaults for payload shaping and the transport. */

export const MAX_STRING_LENGTH = 12_000
export const MAX_DEPTH = 6
export const MAX_ARRAY_ITEMS = 50
export const MAX_OBJECT_KEYS = 80

/** Name for the per-session trace and its root observation. */
export const TRACE_NAME = "opencode-agent"

/** Child-session trace/root name prefix; the redacted agent label follows (feature-013). */
export const SUBAGENT_TRACE_NAME_PREFIX = "opencode-subagent:"

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

/** Overall source-metadata collection deadline (feature-011). */
export const SOURCE_METADATA_TIMEOUT_MS = 2_000

/** Overall standalone test-command abort deadline (feature-012). */
export const LANGFUSE_TEST_TIMEOUT_MS = 15_000

/** Override-file size bound: reads must never buffer unbounded repository files. */
export const MAX_SOURCE_METADATA_FILE_BYTES = 65_536

/** Bounded cap for the final shutdown flush. */
export const SHUTDOWN_TIMEOUT_MS = 5_000

/** Maximum retained session records; overflow evicts the LRU clean inactive record. */
export const MAX_TRACKED_SESSIONS = 256

/** Maximum admitted, not-yet-settled/exported generations per session; overflow refuses telemetry. */
export const MAX_PENDING_GENERATIONS_PER_SESSION = 256

/** Maximum admitted, not-yet-settled/exported tool observations per session; overflow refuses telemetry. */
export const MAX_PENDING_TOOLS_PER_SESSION = 256

/** Maximum retained compaction lifecycles per session; overflow refuses telemetry. */
export const MAX_PENDING_COMPACTIONS_PER_SESSION = 256

/** Maximum combined score-fact identities per session; overflow suppresses score updates. */
export const MAX_SCORE_FACTS_PER_SESSION = 8192

/**
 * Deterministic identity seeds. Trace and root observation ids are derived from the
 * OpenCode session id alone, so a continued or reconstructed session reuses them. No
 * credentials or filesystem paths may enter these seeds.
 */
export const TRACE_SEED_PREFIX = "opencode-langfuse:trace:"
export const ROOT_SEED_PREFIX = "opencode-langfuse:root:"
export const GENERATION_SEED_PREFIX = "opencode-langfuse:generation:"
export const TOOL_SEED_PREFIX = "opencode-langfuse:tool:"
export const COMPACTION_SEED_PREFIX = "opencode-langfuse:compaction:"
export const SCORE_SEED_PREFIX = "opencode-langfuse:score:"

export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"
