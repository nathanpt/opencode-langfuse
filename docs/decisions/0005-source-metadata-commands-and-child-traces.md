# 0005. Source metadata, operational commands, and child-session traces

- Status: accepted (2026-11-10, operator approval)
- Date: 2026-11-10
- Extends: ADR-0001 (active configuration), ADR-0003 (deterministic identity), ADR-0004
  (observation/score lifecycle)
- Binding findings: `node_modules/@opencode/schema/dist/vcs.d.ts` (`Info` has only
  `provider?` + `branch.current/default`), `node_modules/@opencode/schema/dist/session.d.ts`
  (`Info.location.directory`, `parentID?`, `agent?`),
  `node_modules/@opencode/plugin/dist/promise/command.d.ts` (`execute` returns `Promise<void>`),
  pinned core `command.ts`/`vcs.ts` (v2.0.31)

## Context

Features 011–013 complete the feature list: source/git metadata on each trace, the
`/langfuse-status` and `/langfuse-test` operational commands, and child-session (subagent)
traces. R3 proved child sessions are real sessions with `parentID`/`agent` and their own
lifecycle events. Two operator selections bind the design:

- **Feature-011 acquisition: native API plus bounded read-only Git.** `ctx.vcs.get` supplies
  provider and current branch; Git (read-only, child process) supplements only the repository
  root, HEAD commit, and origin URL. A repository-root metadata override file whitelists eight
  documented keys.
- **Feature-012 delivery: server-log-only.** Installed `CommandDefinition.execute` returns
  `Promise<void>` with no text/UI channel, and executing a command does not submit its prompt.
  Commands therefore report through server logs and must never drive a model API, the tracker,
  or the host conversation.

## Decision drivers

- Source facts describe the **session's** location, not the plugin's: `ctx.location.directory`
  is the plugin instance location and must never substitute for `Session.Info.location.directory`.
- ADR-0001 resolves credentials once in `setup`; commands report and test that **active
  configuration**. Re-reading the file per invocation would report a configuration the tracker
  is not using.
- Credentials and secrets never enter metadata, command output, or logs; every emitted string
  passes the redactor.
- The plugin runs inside the long-lived server process; any spawned read must be bounded,
  abortable, and unable to leak environment or block the event stream.
- Child sessions must not lose any of the 001–010 guarantees (deterministic ids, pricing,
  scores, privacy) and must not add a persistence tier or parent registry.

## Decision

### Source metadata (feature-011)

- `collectSourceMetadata(directory, options)` runs one bounded collection (deadline
  `SOURCE_METADATA_TIMEOUT_MS = 2000` combined with unload cancellation):
  `ctx.vcs.get({location:{directory}}, {signal})` and Git work-tree-root detection run
  concurrently; HEAD and origin reads run in parallel only after a root exists.
- Git children use async `execFile("git", ["--no-optional-locks", …read-only…], {cwd, encoding:
  "utf8", timeout, maxBuffer, signal})` — no shell, no status/diff, no fetch, no `.git` file
  parsing. Inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE`/
  `GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES` are stripped from the child env so
  another repository cannot override the session directory.
- Facts: `source_type:"git-repo"`, `repo_root_name` (from the detected root),
  `git_branch` (native `branch.current` only — never the default branch), `git_commit` (Git
  HEAD, 40/64 hex), sanitized `git_remote_host`/`git_remote_path`, and
  `repo_identity`/`repo_owner`/`repo_name` derived from the remote path. A non-`git` native
  provider and nested Git facts are never mixed. Detached HEAD omits the branch; unborn HEAD
  omits the commit; a missing/unusable origin omits remote-derived fields. `metadata_source`
  is `"git-detection"` or `"repo-file"`.
- Overrides: only `<detected-worktree-root>/.opencode-langfuse.metadata.json` (no upward
  search, no non-Git overrides), 64 KiB bound, eight allowed keys (`repo_identity`,
  `repo_owner`, `repo_name`, `source_type`, `service_name`, `project_slug`, `environment`,
  `observability_owner`), trimmed nonempty strings only. Engine/trace keys (`git_commit`,
  `git_branch`, `git_remote_*`, `sessionId`, `completed`, `parentSessionID`, `parent_trace_id`,
  `role`, `agent`) cannot be overridden. An explicit `repo_identity` wins; otherwise owner/name
  overrides recompute the identity. Any invalid read ignores the entire file with one fixed
  diagnostic.
- Acquisition failures are diagnosed once with fixed text (never stdout/stderr, exception
  objects, or the raw remote). No trustworthy directory means no source metadata — no
  `ctx.location.directory` or `process.cwd()` fallback.
- The tracker collects lazily inside the session's state chain when a trustworthy directory
  first appears, retains only the detached sanitized result, and reuses it on every subsequent
  trace upsert of that admission. Applied to **trace metadata only** (plus `sessionId`,
  `completed`); the root observation's metadata is unchanged.

### Operational commands (feature-012)

- `createLangfuseCommands` registers exactly `"langfuse-status"` and `"langfuse-test"` via
  `ctx.command.transform` **before** the unconfigured early-return, so commands exist while
  tracing is disabled. `execute` returns `Promise<void>` and ignores the invocation prompt.
- `/langfuse-status` prints one status block to the server log: state, config source
  (`env|file|none`), redacted host (`redactHost`), `maskPublicKey` public key, base preset plus
  the actual five capture flags, and the retained last runtime error. Disabled state also
  prints the redacted config reason. No file contents, secret key, auth headers, raw paths, or
  provider settings.
- `/langfuse-test` ingests one standalone `"opencode-langfuse-test"` trace/root through the
  active transport (bounded at `LANGFUSE_TEST_TIMEOUT_MS = 15000`), with fresh ids per
  invocation and metadata exactly `{source:"opencode-langfuse", command:"langfuse-test"}`,
  gated by the active capture policy. No tracker mutation, flush, or session linkage.
- Runtime errors are retained plugin-instance-locally by `createRuntimeStatus` (last error
  only: scope, redacted ≤300-char message, ms timestamp), fed by `onError` hooks on the
  transport (`ingestion`: final retry exhaustion or 207 partial rejection) and the tracker
  (`tracker`, plus `source-metadata`, `event`, `event-stream` scopes in setup). Retention
  follows the sibling convention: the last failure survives later successes until another
  failure or plugin reload.

### Child-session traces (feature-013)

- Child sessions are admitted as ordinary tracked sessions with their own deterministic
  identity (`SessionIdentity` unchanged). The `session.created` child exclusion, snapshot
  parent exclusion, `excludedSessions` cache, and `MAX_EXCLUDED_SESSIONS` are deleted; existing
  capacity machinery covers children.
- Child linkage: `role:"subagent"`, `parentSessionID` (direct parent native id),
  `parent_trace_id` (`sessionIdentity(parentID).traceId`), and `agent` when known — trace
  metadata only, through the redactor. Trace and root are named
  `opencode-subagent:<label>` (`SUBAGENT_TRACE_NAME_PREFIX`), where `<label>` is the redacted,
  sanitized (max 120, fallback `"subagent"`) agent name. Top-level Langfuse `sessionId` is the
  **direct parent's** id (truncated), so children group under the parent's Langfuse session
  while keeping their own trace/root.
- Parent facts come from native birth (`session.created.data.parentID/agent`) and
  `Session.Info` (`parentID`, `agent`); a failed info lookup with no parent fact fails open
  with no invented linkage, and a later native birth enriches the same deterministic trace.
  No parent-state lookup, trace-existence check, or parent registry is needed.
- All step/tool/compaction/score machinery operates on the child's own state with unchanged
  formulas; parent counts never include child work; a grandchild links to its direct parent.
  Limits stay 256 tracked sessions / per-session caps / 8192 score facts.

## Consequences

- `parseSessionSnapshot` sets `scoreHistory:{complete:false}` when the transcript read fails
  (an unavailable context is no longer treated as a complete empty history), while first
  prompt/latest output recovery and preserved identity still work when only context failed.
- Source metadata lives per admission: a reconstructed state recollects current repository
  facts; trace updates reassert source fields so an output-only update cannot drop them.
- Command output is visible only in server logs (operator-selected); there is no TUI surface.
- `/langfuse-test` proves accepted ingestion, not immediate indexing; live verification polls
  stored state separately.
- Grandchildren (if a custom native setup produces them) link to their direct parent, never a
  guessed interactive ancestor. An unobserved parent is a deterministic metadata reference.

## Confirmation

- Deterministic: `test/source-metadata.test.ts` (real temp Git repos, overrides, aborts),
  `test/commands.test.ts` + `test/runtime-status.test.ts` (loopback HTTP ingestion), migrated
  `test/tracker|tools|compactions|scores.test.ts` child cases.
- Native/live: `/tmp/oc-features011-013` harness — built plugin under `.opencode/plugins/`,
  mock provider + Langfuse forwarding recorder, real-repo and scratch-repo source cases,
  command invocations through `POST /api/session/<SID>/command`, parent→child subagent
  fixtures asserting exact trace names, linkage, grouping, usage/cost, and score separation.
