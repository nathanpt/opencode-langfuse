/**
 * Feature-011: source/git metadata collection (ADR-0005).
 *
 * Deterministic behavior proof over real temporary Git repositories and the
 * executed collector/tracker — never over Git command strings. The companion
 * setup-level probe of the built plugin runs separately (throwaway script).
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createCapturePolicy } from "../src/capture-policy.js"
import type { IngestEvent, LangfuseTransport } from "../src/langfuse.js"
import { createPricingResolver, type PricingResolver } from "../src/pricing.js"
import { collectSourceMetadata, sanitizeGitRemote } from "../src/source-metadata.js"
import { createTracker, type SessionSnapshot, type Tracker, type TrackerOptions } from "../src/tracker.js"

const BASE = 1_700_000_000_000
const FULL_ENV = { LANGFUSE_PRIVACY_PRESET: undefined } as Record<string, string | undefined>

interface Scratch {
  root: string
  cleanup(): void
}

function makeScratch(name: string): Scratch {
  const root = mkdtempSync(join(tmpdir(), `oc-src-${name}-`))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A real repository on `feature-011-fixture` with one fixture-only commit. */
function makeRepo(name: string, origin?: string, withCommit = true): Scratch {
  const scratch = makeScratch(name)
  git(scratch.root, ["init", "-b", "feature-011-fixture"])
  git(scratch.root, ["config", "user.name", "fixture"])
  git(scratch.root, ["config", "user.email", "fixture@example.invalid"])
  if (withCommit) {
    writeFileSync(join(scratch.root, "file.txt"), "fixture\n")
    git(scratch.root, ["add", "file.txt"])
    git(scratch.root, ["commit", "-m", "fixture commit"])
  }
  if (origin !== undefined) {
    git(scratch.root, ["remote", "add", "origin", origin])
  }
  return scratch
}

interface NativeVcsStub {
  provider?: string
  current?: string
  default?: string
}

function nativeEnvelope(stub: NativeVcsStub): unknown {
  return {
    location: { directory: "/irrelevant/plugin/location" },
    data: {
      provider: stub.provider,
      branch: { current: stub.current, default: stub.default },
    },
  }
}

function collect(
  directory: string,
  stub: NativeVcsStub = { provider: "git", current: "feature-011-fixture" },
  logs?: string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return collectSourceMetadata(directory, {
    readVcs: async () => nativeEnvelope(stub),
    ...(signal ? { signal } : {}),
    ...(logs ? { log: (message: string) => logs.push(message) } : { log: () => {} }),
  }) as Promise<Record<string, string>>
}

// ---- sanitizeGitRemote: shape and rejection rules.

test("credential-bearing HTTPS origins yield host/path and identity only", () => {
  const remote = "https://fixture-user:fixture-password@git.example.invalid/demo/opencode-source.git?token=sk-ant-x#ignored"
  const sanitized = sanitizeGitRemote(remote)
  assert.deepEqual(sanitized, { git_remote_host: "git.example.invalid", git_remote_path: "demo/opencode-source" })
  const flat = JSON.stringify(sanitized)
  for (const forbidden of ["fixture-user", "fixture-password", "https:", "token=", "sk-ant-x", "#ignored", ".git"]) {
    assert.ok(!flat.includes(forbidden), `sanitized remote must not contain ${forbidden}`)
  }
})

test("scp-like origins discard query/fragment and reject local paths or leftover @", () => {
  assert.deepEqual(sanitizeGitRemote("git@github.com:owner/repo.git"), {
    git_remote_host: "github.com",
    git_remote_path: "owner/repo",
  })
  assert.deepEqual(sanitizeGitRemote("git@github.com:owner/repo.git?token=x#f"), {
    git_remote_host: "github.com",
    git_remote_path: "owner/repo",
  })
  assert.deepEqual(sanitizeGitRemote("git@github.com:owner/repo@extra"), {})
  assert.deepEqual(sanitizeGitRemote("C:\\Users\\dev\\repo"), {})
  assert.deepEqual(sanitizeGitRemote("/home/dev/local-repo"), {})
  assert.deepEqual(sanitizeGitRemote("file:///srv/local/repo.git"), {})
})

// ---- collector over real repositories.

test("git repository with credential-bearing origin emits sanitized facts and git-detection source", async () => {
  const repo = makeRepo("https", "https://fixture-user:fixture-password@git.example.invalid/demo/opencode-source.git?token=sk-ant-feature1113-canary#ignored")
  try {
    const logs: string[] = []
    const metadata = await collect(repo.root, { provider: "git", current: "feature-011-fixture", default: "main" }, logs)
    assert.equal(metadata.source_type, "git-repo")
    assert.equal(metadata.git_branch, "feature-011-fixture")
    assert.equal(metadata.repo_root_name, repo.root.split("/").pop())
    assert.equal(metadata.git_remote_host, "git.example.invalid")
    assert.equal(metadata.git_remote_path, "demo/opencode-source")
    assert.equal(metadata.repo_owner, "demo")
    assert.equal(metadata.repo_name, "opencode-source")
    assert.equal(metadata.repo_identity, "demo/opencode-source")
    assert.equal(metadata.metadata_source, "git-detection")
    const commit = git(repo.root, ["rev-parse", "HEAD"])
    assert.equal(metadata.git_commit, commit)
    const flat = JSON.stringify(metadata)
    for (const forbidden of ["fixture-user", "fixture-password", "https:", "sk-ant-feature1113-canary", ".git", "main"]) {
      assert.ok(!flat.includes(forbidden), `metadata must not contain ${forbidden}`)
    }
    assert.equal(logs.length, 0)
  } finally {
    repo.cleanup()
  }
})

test("inherited GIT_DIR cannot redirect the child reads at another repository", async () => {
  const repo = makeRepo("env", "https://git.example.invalid/demo/env-scrub.git")
  const other = makeRepo("env-other")
  const previous = process.env.GIT_DIR
  try {
    process.env.GIT_DIR = join(other.root, ".git")
    const metadata = await collect(repo.root)
    assert.equal(metadata.repo_root_name, repo.root.split("/").pop())
    assert.equal(metadata.repo_identity, "demo/env-scrub")
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_DIR
    } else {
      process.env.GIT_DIR = previous
    }
    repo.cleanup()
    other.cleanup()
  }
})

test("root override file replaces only documented keys and recomputes owner/name identity", async () => {
  const repo = makeRepo("overrides", "https://git.example.invalid/demo/opencode-source.git")
  try {
    writeFileSync(
      join(repo.root, ".opencode-langfuse.metadata.json"),
      JSON.stringify({
        repo_identity: "fixture/override",
        repo_owner: "fixture",
        repo_name: "override",
        service_name: "source-check",
        environment: "verification",
        // Rejected keys: engine/trace facts and arbitrary strings.
        git_commit: "bogus",
        git_branch: "bogus",
        git_remote_host: "bogus",
        sessionId: "bogus",
        parent_trace_id: "bogus",
        token: "must-not-pass",
        unknown_key: "must-not-pass",
        repo_number: 12,
      }),
    )
    const metadata = await collect(repo.root)
    assert.equal(metadata.repo_identity, "fixture/override")
    assert.equal(metadata.repo_owner, "fixture")
    assert.equal(metadata.repo_name, "override")
    assert.equal(metadata.service_name, "source-check")
    assert.equal(metadata.environment, "verification")
    assert.equal(metadata.metadata_source, "repo-file")
    // Real detected facts survive; rejected keys cannot alter emitted data.
    assert.equal(metadata.git_branch, "feature-011-fixture")
    assert.equal(metadata.git_remote_host, "git.example.invalid")
    assert.equal(metadata.git_commit, git(repo.root, ["rev-parse", "HEAD"]))
    const flat = JSON.stringify(metadata)
    for (const key of ["sessionId", "parent_trace_id", "token", "unknown_key", "repo_number", "bogus", "must-not-pass"]) {
      assert.ok(!flat.includes(key), `metadata must not contain ${key}`)
    }
  } finally {
    repo.cleanup()
  }
})

test("owner-only override recomputes identity; a slash-containing repo name is ignored", async () => {
  const repo = makeRepo("slash-name", "https://git.example.invalid/demo/detected-name.git")
  try {
    writeFileSync(
      join(repo.root, ".opencode-langfuse.metadata.json"),
      JSON.stringify({ repo_owner: "fixture", repo_name: "bad/name", repo_identity: "" }),
    )
    const metadata = await collect(repo.root)
    // Empty repo_identity is dropped; slash repo_name is dropped; the
    // remaining owner override recomputes the identity from final values.
    assert.equal(metadata.repo_owner, "fixture")
    assert.equal(metadata.repo_name, "detected-name")
    assert.equal(metadata.repo_identity, "fixture/detected-name")
    assert.equal(metadata.metadata_source, "repo-file")
  } finally {
    repo.cleanup()
  }
})

test("from a nested directory only the root override file applies", async () => {
  const repo = makeRepo("nested", "https://git.example.invalid/demo/nested-source.git")
  try {
    writeFileSync(join(repo.root, ".opencode-langfuse.metadata.json"), JSON.stringify({ service_name: "root-file" }))
    const nested = join(repo.root, "packages", "app")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, ".opencode-langfuse.metadata.json"), JSON.stringify({ service_name: "nested-file", environment: "conflict" }))
    const metadata = await collect(nested)
    assert.equal(metadata.service_name, "root-file")
    assert.equal(metadata.environment, undefined)
    assert.equal(metadata.metadata_source, "repo-file")
    assert.equal(metadata.repo_identity, "demo/nested-source")
  } finally {
    repo.cleanup()
  }
})

test("unusable override files leave detected git facts intact with one fixed diagnostic", async () => {
  const cases: Array<[string, string, boolean]> = [
    ["invalid-json", "{ not json", true],
    ["array-top", JSON.stringify(["repo_identity"]), true],
    ["oversize", JSON.stringify({ environment: "x".repeat(70_000) }), true],
  ]
  for (const [name, content] of cases) {
    const repo = makeRepo(`bad-${name}`, "https://git.example.invalid/demo/bad-file.git")
    try {
      writeFileSync(join(repo.root, ".opencode-langfuse.metadata.json"), content)
      const logs: string[] = []
      const metadata = await collect(repo.root, { provider: "git", current: "feature-011-fixture" }, logs)
      assert.equal(metadata.source_type, "git-repo")
      assert.equal(metadata.git_commit, git(repo.root, ["rev-parse", "HEAD"]))
      assert.equal(metadata.repo_identity, "demo/bad-file")
      assert.equal(metadata.metadata_source, "git-detection")
      assert.equal(metadata.service_name, undefined)
      assert.equal(logs.filter((m) => m.includes("Source metadata override ignored")).length, 1, name)
    } finally {
      repo.cleanup()
    }
  }
})

test("a non-Git directory ignores its override file and reports non-git", async () => {
  const plain = makeScratch("plain")
  try {
    writeFileSync(join(plain.root, ".opencode-langfuse.metadata.json"), JSON.stringify({ service_name: "must-not-leak" }))
    const logs: string[] = []
    const metadata = await collect(plain.root, { current: undefined }, logs)
    assert.equal(metadata.source_type, "non-git")
    assert.equal(metadata.metadata_source, "non-git")
    assert.equal(metadata.service_name, undefined)
    assert.equal(metadata.git_commit, undefined)
    assert.equal(logs.length, 0)
  } finally {
    plain.cleanup()
  }
})

test("valid native response without provider and without root reports non-git", async () => {
  const plain = makeScratch("native-non-git")
  try {
    const metadata = await collect(plain.root, { provider: undefined, current: undefined })
    assert.deepEqual(metadata, { source_type: "non-git", metadata_source: "non-git" })
  } finally {
    plain.cleanup()
  }
})

test("a non-Git native provider never mixes nested git facts", async () => {
  const repo = makeRepo("jj-provider", "https://git.example.invalid/demo/jj.git")
  try {
    const metadata = await collect(repo.root, { provider: "jj", current: "trunk" })
    assert.equal(metadata.source_type, "non-git")
    assert.equal(metadata.metadata_source, "non-git")
    assert.equal(metadata.git_commit, undefined)
    assert.equal(metadata.repo_root_name, undefined)
    assert.equal(metadata.git_branch, undefined)
  } finally {
    repo.cleanup()
  }
})

test("missing origin keeps the root name as the local identity without invented owner", async () => {
  const repo = makeRepo("no-origin")
  try {
    const metadata = await collect(repo.root)
    assert.equal(metadata.source_type, "git-repo")
    assert.equal(metadata.repo_root_name, repo.root.split("/").pop())
    assert.equal(metadata.git_remote_host, undefined)
    assert.equal(metadata.repo_owner, undefined)
    assert.equal(metadata.repo_identity, undefined)
    assert.equal(metadata.git_commit, git(repo.root, ["rev-parse", "HEAD"]))
    assert.equal(metadata.metadata_source, "git-detection")
  } finally {
    repo.cleanup()
  }
})

test("unborn HEAD omits the commit; native default branch is never substituted for current", async () => {
  const repo = makeRepo("unborn", undefined, false)
  try {
    const metadata = await collect(repo.root, { provider: "git", default: "main" })
    assert.equal(metadata.source_type, "git-repo")
    assert.equal(metadata.git_commit, undefined)
    assert.equal(metadata.git_branch, undefined)
    assert.equal(metadata.repo_root_name, repo.root.split("/").pop())
  } finally {
    repo.cleanup()
  }
})

test("a failed native read never invents a branch; complete git facts stay silent", async () => {
  const repo = makeRepo("native-fail", "https://git.example.invalid/demo/native-fail.git")
  try {
    const logs: string[] = []
    const metadata = await collectSourceMetadata(repo.root, {
      readVcs: async () => {
        throw new Error("native vcs unavailable")
      },
      log: (message: string) => logs.push(message),
    }) as Record<string, string>
    assert.equal(metadata.source_type, "git-repo")
    assert.equal(metadata.git_branch, undefined)
    assert.equal(metadata.git_commit, git(repo.root, ["rev-parse", "HEAD"]))
    assert.equal(metadata.repo_identity, "demo/native-fail")
    assert.equal(logs.length, 0)
  } finally {
    repo.cleanup()
  }
})

test("an aborted collector settles with no facts and never mutates them later", async () => {
  const repo = makeRepo("aborted", "https://git.example.invalid/demo/aborted.git")
  try {
    const controller = new AbortController()
    const logs: string[] = []
    const pending = collectSourceMetadata(repo.root, {
      // Ignores the abort signal, like the plan's worst-case native reader.
      readVcs: () => new Promise(() => {}),
      signal: controller.signal,
      log: (message: string) => logs.push(message),
    })
    controller.abort()
    const metadata = (await pending) as Record<string, string>
    assert.deepEqual(metadata, {})
    assert.equal(logs.filter((m) => m.includes("Source metadata unavailable")).length, 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(metadata, {})
    assert.deepEqual(Object.keys(metadata).sort(), [])
  } finally {
    repo.cleanup()
  }
})

test("collected values pass the redactor", async () => {
  const repo = makeRepo("redaction", "https://git.example.invalid/demo/redaction.git")
  try {
    writeFileSync(
      join(repo.root, ".opencode-langfuse.metadata.json"),
      JSON.stringify({ environment: "leak sk-ant-feature1113-canary tail" }),
    )
    const metadata = await collect(repo.root)
    assert.ok(metadata.environment?.includes("[REDACTED_SECRET]"))
    assert.ok(!JSON.stringify(metadata).includes("sk-ant-feature1113-canary"))
  } finally {
    repo.cleanup()
  }
})

test("empty and relative directories produce no fabricated source", async () => {
  const logs: string[] = []
  assert.deepEqual(await collect("", { provider: "git", current: "x" }, logs), {})
  assert.deepEqual(await collect("relative/path", { provider: "git", current: "x" }, logs), {})
  assert.equal(logs.filter((m) => m.includes("Source metadata unavailable")).length, 2)
})

// ---- tracker integration: per-directory collection and export placement.

interface FakeTransport extends LangfuseTransport {
  batches: IngestEvent[][]
}

function fakeTransport(): FakeTransport {
  const batches: IngestEvent[][] = []
  return {
    batches,
    async ingest(events: IngestEvent[]) {
      batches.push(events)
      return { accepted: events.length, failed: 0 }
    },
  }
}

function testPricing(): PricingResolver {
  return createPricingResolver({ loadCatalog: async () => ({ data: [] }), log: () => {} })
}

const POLICY = createCapturePolicy({ preset: "conversations", env: FULL_ENV })

function traceId(sessionID: string): string {
  return createHash("sha256").update(`opencode-langfuse:trace:${sessionID}`, "utf8").digest("hex").slice(0, 32)
}
function rootId(sessionID: string): string {
  return createHash("sha256").update(`opencode-langfuse:root:${sessionID}`, "utf8").digest("hex").slice(0, 16)
}

function makeTracker(transport: FakeTransport, overrides: Partial<TrackerOptions> = {}, logs: string[] = []): Tracker {
  let seq = 0
  return createTracker({
    transport,
    policy: POLICY,
    pricing: testPricing(),
    flushDelayMs: 5,
    newId: () => `id-${(seq += 1)}`,
    now: () => BASE + 10_000,
    log: (message: string) => logs.push(message),
    ...overrides,
  })
}

function ev(sessionID: string, type: string, created: number, data: Record<string, unknown>, seq?: number): Record<string, unknown> {
  return {
    type,
    created,
    ...(seq !== undefined ? { durable: { aggregateID: sessionID, seq, version: 1 } } : {}),
    data,
  }
}

function metaOf(event: IngestEvent): Record<string, unknown> {
  return (event.body.metadata ?? {}) as Record<string, unknown>
}

test("two native session directories collect their own real source facts", async () => {
  const repoA = makeRepo("repo-a", "https://git.example.invalid/demo/repo-a.git")
  const repoB = makeRepo("repo-b", "https://git.example.invalid/other/repo-b.git")
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {
    // The plugin-location stand-in differs from both session directories.
    lookupSourceMetadata: (directory) =>
      collectSourceMetadata(directory, {
        readVcs: async (dir: string) =>
          nativeEnvelope(dir === repoA.root ? { provider: "git", current: "feature-011-fixture" } : { provider: "git", current: "other-branch" }),
        log: (message: string) => logs.push(message),
      }),
  })
  const sidA = "ses_aaa"
  const sidB = "ses_bbb"
  try {
    await tracker.handleEvent(ev(sidA, "session.created", BASE, { sessionID: sidA, location: { directory: repoA.root } }, 0))
    await tracker.handleEvent(ev(sidA, "session.inbox.enqueued", BASE + 100, { sessionID: sidA, item: { type: "user", payload: { text: "prompt a" } } }, 1))
    await tracker.handleEvent(ev(sidB, "session.created", BASE + 110, { sessionID: sidB, location: { directory: repoB.root } }, 0))
    await tracker.handleEvent(ev(sidA, "session.execution.succeeded", BASE + 200, { sessionID: sidA }, 2))
    await tracker.handleEvent(ev(sidB, "session.execution.succeeded", BASE + 210, { sessionID: sidB }, 1))
    await tracker.flushAll()

    const traceA = transport.batches.flat().filter((e) => e.type === "trace-create" && e.body.id === traceId(sidA))
    const traceB = transport.batches.flat().filter((e) => e.type === "trace-create" && e.body.id === traceId(sidB))
    assert.ok(traceA.length >= 1 && traceB.length >= 1)
    const metaA = metaOf(traceA[traceA.length - 1])
    const metaB = metaOf(traceB[traceB.length - 1])
    assert.equal(metaA.repo_identity, "demo/repo-a")
    assert.equal(metaA.git_branch, "feature-011-fixture")
    assert.equal(metaA.git_commit, git(repoA.root, ["rev-parse", "HEAD"]))
    assert.equal(metaA.source_type, "git-repo")
    assert.equal(metaB.repo_identity, "other/repo-b")
    assert.equal(metaB.git_branch, "other-branch")
    assert.equal(metaB.git_commit, git(repoB.root, ["rev-parse", "HEAD"]))
    assert.equal(metaA.sessionId, sidA)
    assert.equal(metaA.completed, true)

    // Source metadata is trace-only: the root span and child observations
    // never gain it, and repeated updates keep it.
    const rootEvents = transport.batches.flat().filter((e) => e.body.id === rootId(sidA) || e.body.id === rootId(sidB))
    assert.ok(rootEvents.length >= 1)
    for (const event of rootEvents) {
      const meta = metaOf(event)
      assert.equal(meta.repo_identity, undefined)
      assert.equal(meta.source_type, undefined)
      assert.equal(meta.sessionId, event.body.id === rootId(sidA) ? sidA : sidB)
    }
    for (const event of transport.batches.flat()) {
      if (event.type.startsWith("generation-")) {
        assert.equal(metaOf(event).repo_identity, undefined)
      }
    }
    const laterTraceA = traceA[traceA.length - 1]
    assert.equal(metaOf(laterTraceA).repo_identity, "demo/repo-a")
  } finally {
    repoA.cleanup()
    repoB.cleanup()
  }
})

test("no trustworthy directory means no fabricated source metadata", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {
    lookupSourceMetadata: (directory) =>
      collectSourceMetadata(directory, { readVcs: async () => nativeEnvelope({ provider: "git", current: "x" }), log: (m) => logs.push(m) }),
  })
  const sid = "ses_nodir"
  await tracker.handleEvent(ev(sid, "session.created", BASE, { sessionID: sid }, 0))
  await tracker.handleEvent(ev(sid, "session.execution.succeeded", BASE + 100, { sessionID: sid }, 1))
  await tracker.flushAll()
  const traces = transport.batches.flat().filter((e) => e.type === "trace-create" && e.body.id === traceId(sid))
  assert.ok(traces.length >= 1)
  const meta = metaOf(traces[traces.length - 1])
  assert.deepEqual(meta, { sessionId: sid, completed: true })
  assert.equal(logs.filter((m) => m.includes("Source metadata")).length, 0)
})

test("a rejecting collector never blocks exports and diagnoses once", async () => {
  const transport = fakeTransport()
  const logs: string[] = []
  const tracker = makeTracker(transport, {
    lookupSourceMetadata: async () => {
      throw new Error("collector exploded")
    },
  }, logs)
  const sid = "ses_fail"
  await tracker.handleEvent(ev(sid, "session.created", BASE, { sessionID: sid, location: { directory: "/tmp" } }, 0))
  await tracker.handleEvent(ev(sid, "session.execution.succeeded", BASE + 100, { sessionID: sid }, 1))
  await tracker.flushAll()
  const traces = transport.batches.flat().filter((e) => e.type === "trace-create" && e.body.id === traceId(sid))
  assert.ok(traces.length >= 1)
  assert.deepEqual(metaOf(traces[traces.length - 1]), { sessionId: sid, completed: true })
  assert.equal(logs.filter((m) => m.includes("source metadata collection failed")).length, 1)
})

test("a restored session with unavailable context reconciles identity but omits scores", async () => {
  const repo = makeRepo("restored", "https://git.example.invalid/demo/restored.git")
  const transport = fakeTransport()
  const logs: string[] = []
  const sid = "ses_cold"
  const tracker = makeTracker(transport, {
    lookupSession: async (sessionID): Promise<SessionSnapshot | undefined> =>
      sessionID === sid
        ? {
            createdAt: BASE,
            directory: repo.root,
            firstPrompt: "restored prompt",
            latestAssistantOutput: "restored answer",
            // Context read failed: transcript unavailable.
            scoreHistory: { complete: false },
          }
        : undefined,
    lookupSourceMetadata: (directory) =>
      collectSourceMetadata(directory, { readVcs: async () => nativeEnvelope({ provider: "git", current: "feature-011-fixture" }) }),
  }, logs)
  try {
    await tracker.handleEvent(ev(sid, "session.inbox.enqueued", BASE + 100, { sessionID: sid, item: { type: "user", payload: { text: "restored prompt" } } }, 1))
    await tracker.handleEvent(
      ev(sid, "session.step.started", BASE + 200, { sessionID: sid, assistantMessageID: "msg_1", agent: "build", model: { id: "mock-1", providerID: "mock" }, started: BASE + 199 }, 2),
    )
    await tracker.handleEvent(
      ev(sid, "session.step.ended", BASE + 300, { sessionID: sid, assistantMessageID: "msg_1", finish: "stop", cost: 5, tokens: { input: 37, output: 5, reasoning: 2, cache: { read: 5, write: 0 } } }, 3),
    )
    await tracker.handleEvent(ev(sid, "session.execution.succeeded", BASE + 400, { sessionID: sid }, 4))
    await tracker.flushAll()

    const flat = transport.batches.flat()
    const trace = flat.find((e) => e.type === "trace-create" && e.body.id === traceId(sid))
    assert.ok(trace)
    const meta = metaOf(trace)
    assert.equal(meta.repo_identity, "demo/restored")
    assert.equal(meta.git_commit, git(repo.root, ["rev-parse", "HEAD"]))
    assert.equal(trace.body.input, "restored prompt")
    assert.equal(flat.filter((e) => e.type === "score-create").length, 0)
    assert.equal(logs.filter((m) => m.includes("Scores omitted")).length, 1)
  } finally {
    repo.cleanup()
  }
})
