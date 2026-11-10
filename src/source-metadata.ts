/**
 * Source/git metadata collection (feature-011, ADR-0005).
 *
 * Native VCS facts (`ctx.vcs.get`: provider, current branch) arrive through
 * the injected `readVcs` callback; bounded read-only Git commands supplement
 * only the work-tree root, HEAD, and origin. A repository-root override file
 * may add/replace eight documented keys. Every retained value passes the
 * redactor; failures diagnose with fixed text and never echo command output,
 * exception objects, or the raw remote.
 */

import { execFile } from "node:child_process"
import { open, type FileHandle } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import {
  MAX_SOURCE_METADATA_FILE_BYTES,
  SOURCE_METADATA_TIMEOUT_MS,
} from "./constants.js"
import { isRecord } from "./guards.js"
import { redactString } from "./redaction.js"

export type SourceMetadata = Readonly<Record<string, string>>

export interface SourceMetadataOptions {
  readVcs(directory: string, signal: AbortSignal): Promise<unknown>
  signal?: AbortSignal
  log?: (message: string) => void
}

/** Fixed diagnostics: at most one of each per collection; never dynamic detail. */
const SOURCE_METADATA_UNAVAILABLE = "Source metadata unavailable"
const SOURCE_METADATA_OVERRIDE_IGNORED = "Source metadata override ignored"

const OVERRIDE_FILE_NAME = ".opencode-langfuse.metadata.json"

const OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "repo_identity",
  "repo_owner",
  "repo_name",
  "source_type",
  "service_name",
  "project_slug",
  "environment",
  "observability_owner",
])

/** Repo-level environment overrides that could redirect Git at another repository. */
const GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

interface GitOutcome {
  stdout?: string
  /** True when git refused normally (non-zero exit): HEAD/origin absence. */
  normalFailure: boolean
  /** Killed, aborted, timed out, or not executable: unexpected acquisition failure. */
  unexpected: boolean
}

function noop(): void {}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * One bounded read-only Git command: no shell, `--no-optional-locks`, capped
 * output, per-call timeout, external abort, and a child-only environment with
 * repo-redirecting Git variables stripped. Never rejects.
 */
function runGit(directory: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<GitOutcome> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env }
    for (const key of GIT_ENV_KEYS) {
      delete env[key]
    }
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd: directory, encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_SOURCE_METADATA_FILE_BYTES, signal, env },
      (error, stdout) => {
        if (error === undefined || error === null) {
          resolve({ stdout: typeof stdout === "string" ? stdout : undefined, normalFailure: false, unexpected: false })
          return
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean }
        // A numeric exit code is a normal git refusal (missing HEAD, no
        // origin); killed/signal/ENOENT-style failures are unexpected.
        const normalFailure = typeof err.code === "number" && err.killed !== true
        resolve({
          stdout: typeof stdout === "string" ? stdout : undefined,
          normalFailure,
          unexpected: !normalFailure,
        })
      },
    )
  })
}

/**
 * Strips scheme, userinfo, query, fragment, leading path slashes, and the
 * trailing `.git`; scp-like syntax also discards query/fragment and rejects
 * local/Windows paths or a leftover `@` in the repository path. Anything
 * unsupported yields no remote fields.
 */
export function sanitizeGitRemote(remote: string): SourceMetadata {
  const raw = firstLine(remote).replace(/[?#].*$/, "").replace(/\.git$/i, "")
  if (!raw) {
    return {}
  }
  try {
    const parsed = new URL(raw)
    const path = parsed.pathname.replace(/^\/+/, "")
    if (isNonEmptyString(parsed.hostname) && isNonEmptyString(path)) {
      return { git_remote_host: parsed.hostname, git_remote_path: path }
    }
    return {}
  } catch {
    // Continue with scp-like SSH syntax, for example git@github.com:owner/repo.git.
  }
  const scpLike = raw.match(/^(?:[^@\s/:]+@)?([^:\s]+):(.+)$/)
  if (scpLike) {
    const host = scpLike[1]
    const path = scpLike[2].replace(/^\/+/, "")
    if (!isNonEmptyString(host) || !isNonEmptyString(path)) {
      return {}
    }
    if (/^[A-Za-z]:$/.test(host) || path.includes("\\") || path.includes("@")) {
      return {}
    }
    return { git_remote_host: host, git_remote_path: path }
  }
  return {}
}

function deriveIdentity(remotePath: string | undefined): SourceMetadata {
  if (!isNonEmptyString(remotePath)) {
    return {}
  }
  const parts = remotePath.split("/").filter(Boolean)
  if (parts.length < 2) {
    return {}
  }
  const repoName = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  if (!isNonEmptyString(repoName) || !isNonEmptyString(owner)) {
    return {}
  }
  return { repo_identity: `${owner}/${repoName}`, repo_owner: owner, repo_name: repoName }
}

interface NativeVcsFacts {
  /** A well-formed `{location, data}` envelope arrived (contents may be empty). */
  valid: boolean
  provider?: string
  currentBranch?: string
}

function parseNativeVcs(value: unknown): NativeVcsFacts {
  if (!isRecord(value) || !isRecord(value.data)) {
    return { valid: false }
  }
  const data = value.data
  const provider = isNonEmptyString(data.provider) ? data.provider : undefined
  const branch = isRecord(data.branch) ? data.branch : undefined
  const currentBranch = isNonEmptyString(branch?.current) ? (branch?.current as string) : undefined
  return { valid: true, provider, currentBranch }
}

function redactAll(metadata: Record<string, string>): SourceMetadata {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    output[key] = redactString(value)
  }
  return output
}

interface OverrideRead {
  values: SourceMetadata
  /** A file existed but was unusable (bad JSON/array/oversize/read error). */
  ignored: boolean
}

/**
 * Reads `<worktreeRoot>/.opencode-langfuse.metadata.json` only: no upward
 * search, no non-Git overrides. Reads at most limit+1 bytes so growth during
 * the read cannot slip past the bound; missing is normal, unusable ignores
 * the entire file.
 */
async function readOverrides(
  worktreeRoot: string,
  signal: AbortSignal,
  remainingMs: () => number,
): Promise<OverrideRead> {
  const path = join(worktreeRoot, OVERRIDE_FILE_NAME)
  let handle: FileHandle
  try {
    handle = await open(path, "r")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { values: {}, ignored: false }
    }
    return { values: {}, ignored: true }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      return { values: {}, ignored: true }
    }
    if (signal.aborted || remainingMs() <= 0) {
      return { values: {}, ignored: true }
    }
    const buffer = Buffer.alloc(MAX_SOURCE_METADATA_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, MAX_SOURCE_METADATA_FILE_BYTES + 1, 0)
    if (bytesRead > MAX_SOURCE_METADATA_FILE_BYTES) {
      return { values: {}, ignored: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead))
    } catch {
      return { values: {}, ignored: true }
    }
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return { values: {}, ignored: true }
    }
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!OVERRIDE_KEYS.has(key) || typeof value !== "string") {
        continue
      }
      const trimmed = value.trim()
      if (trimmed.length === 0) {
        continue
      }
      if (key === "repo_name" && (trimmed.includes("/") || trimmed.includes("\\"))) {
        continue
      }
      values[key] = trimmed
    }
    return { values, ignored: false }
  } catch {
    return { values: {}, ignored: true }
  } finally {
    await handle.close().catch(noop)
  }
}

/**
 * Collects the source metadata for one directory under one combined deadline
 * (unload cancellation + `SOURCE_METADATA_TIMEOUT_MS`). Resolves with a
 * detached, redacted, frozen record; a late native resolution never mutates
 * it. Expected results: git-repo facts, `{source_type:"non-git"}`, or `{}`.
 */
export async function collectSourceMetadata(
  directory: string,
  options: SourceMetadataOptions,
): Promise<SourceMetadata> {
  const log = options.log ?? noop
  const external = options.signal
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (external?.aborted) {
    onExternalAbort()
  } else {
    external?.addEventListener("abort", onExternalAbort, { once: true })
  }

  const unavailable = (): SourceMetadata => {
    log(SOURCE_METADATA_UNAVAILABLE)
    return {}
  }

  // Reject empty/non-absolute collector directories: never a process-CWD
  // fallback; the plugin location is not the session location.
  if (typeof directory !== "string" || directory.length === 0 || !isAbsolute(directory)) {
    if (external !== undefined && !external.aborted) {
      external.removeEventListener("abort", onExternalAbort)
    }
    return unavailable()
  }

  try {
    const deadlineAt = Date.now() + SOURCE_METADATA_TIMEOUT_MS
    const signal = controller.signal
    const remainingMs = () => deadlineAt - Date.now()
    const expired = () => signal.aborted || remainingMs() <= 0

    const nativeSettled: Promise<NativeVcsFacts | undefined> = Promise.resolve()
      .then(() => options.readVcs(directory, signal))
      .then(
        (value): NativeVcsFacts => parseNativeVcs(value),
        (): NativeVcsFacts => ({ valid: false }),
      )

    // Race the (possibly abort-ignoring) native reader against the deadline.
    // The deadline settles on abort, on expiry, or when time runs out; the
    // orphan's late settlement is mapped and discarded — it can never mutate
    // the retained result.
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined
    let removeAbortForward: () => void = noop
    const deadline = new Promise<undefined>((resolve) => {
      const finish = () => resolve(undefined)
      if (signal.aborted) {
        finish()
        return
      }
      signal.addEventListener("abort", finish, { once: true })
      removeAbortForward = () => signal.removeEventListener("abort", finish)
      const wait = Math.max(0, remainingMs())
      if (wait === 0) {
        finish()
        return
      }
      deadlineHandle = setTimeout(finish, wait)
      deadlineHandle.unref?.()
    })
    const raced = await Promise.race([nativeSettled, deadline])
    if (deadlineHandle !== undefined) {
      clearTimeout(deadlineHandle)
    }
    removeAbortForward()
    const native = raced
    void nativeSettled.catch(noop)

    let detected: Record<string, string> = {}
    let unexpectedFailure = false
    let rootPath: string | undefined

    if (native !== undefined && native.valid && native.provider !== undefined && native.provider !== "git") {
      // A native non-Git provider is authoritative; never mix nested Git facts.
      detected = { source_type: "non-git", metadata_source: "non-git" }
    } else {
      const rootOutcome = expired()
        ? undefined
        : await runGit(directory, ["rev-parse", "--show-toplevel"], signal, Math.max(1, remainingMs()))
      if (rootOutcome?.unexpected) {
        unexpectedFailure = true
      }
      rootPath =
        rootOutcome?.stdout !== undefined && !rootOutcome.unexpected && isNonEmptyString(firstLine(rootOutcome.stdout))
          ? firstLine(rootOutcome.stdout)
          : undefined
      const rootDetected = rootPath !== undefined
      const providerGit = native !== undefined && native.valid && native.provider === "git"

      if (!providerGit && !rootDetected) {
        if (native !== undefined && native.valid) {
          // A valid native response with no provider and no detected root.
          detected = { source_type: "non-git", metadata_source: "non-git" }
        } else {
          return unavailable()
        }
      } else {
        detected = { source_type: "git-repo", metadata_source: "git-detection" }
        if (rootPath !== undefined) {
          detected.repo_root_name = basename(rootPath)
        }
        if (providerGit && native.currentBranch !== undefined) {
          // Native current branch only; the default branch is never HEAD.
          detected.git_branch = native.currentBranch
        }
        if (expired()) {
          unexpectedFailure = true
        } else {
          const [head, origin] = await Promise.all([
            runGit(directory, ["rev-parse", "--verify", "HEAD"], signal, Math.max(1, remainingMs())),
            runGit(directory, ["config", "--get", "remote.origin.url"], signal, Math.max(1, remainingMs())),
          ])
          if (head.unexpected || origin.unexpected) {
            unexpectedFailure = true
          }
          if (!head.unexpected && head.stdout !== undefined) {
            const commit = firstLine(head.stdout)
            if (COMMIT_RE.test(commit)) {
              detected.git_commit = commit
            }
          }
          if (!origin.unexpected && origin.stdout !== undefined) {
            const remote = firstLine(origin.stdout)
            if (isNonEmptyString(remote)) {
              const remoteFacts = sanitizeGitRemote(remote)
              Object.assign(detected, remoteFacts)
              Object.assign(detected, deriveIdentity(remoteFacts.git_remote_path))
            }
          }
        }
      }
    }

    // Overrides only from the detected work-tree root, never for non-Git.
    let overrides: SourceMetadata = {}
    if (detected.source_type === "git-repo" && !expired() && rootPath !== undefined) {
      const read = await readOverrides(rootPath, signal, remainingMs)
      overrides = read.values
      if (read.ignored) {
        log(SOURCE_METADATA_OVERRIDE_IGNORED)
      }
    }

    // Merge accepted overrides after detected facts.
    const merged: Record<string, string> = { ...detected, ...overrides }
    if (
      overrides.repo_identity === undefined &&
      (overrides.repo_owner !== undefined || overrides.repo_name !== undefined)
    ) {
      const owner = merged.repo_owner
      const name = merged.repo_name
      if (isNonEmptyString(owner) && isNonEmptyString(name)) {
        merged.repo_identity = `${owner}/${name}`
      }
    }
    merged.metadata_source = Object.keys(overrides).length > 0 ? "repo-file" : (detected.metadata_source ?? "git-detection")

    if (unexpectedFailure) {
      // Known partial Git facts with the same fixed diagnostic, once.
      log(SOURCE_METADATA_UNAVAILABLE)
    }
    return redactAll(merged)
  } finally {
    external?.removeEventListener("abort", onExternalAbort)
  }
}
