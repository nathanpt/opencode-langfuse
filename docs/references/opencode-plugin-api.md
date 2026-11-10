# OpenCode v2 plugin API — verified notes

Verified against the official OpenCode docs on 2026-11-09, cross-checked with the installed CLI
(`opencode --version` → `v2.0.31`). Sources:

- Configure/install plugins: <https://opencode.ai/docs/plugins>
- Build a plugin (parts, load, publish): <https://opencode.ai/docs/build/plugins>
- Server part (lifecycle, context, API, hooks): <https://opencode.ai/docs/build/plugins/server>
- V1 → V2 migration: <https://opencode.ai/docs/build/plugins/migrate-v1>

**Caveat:** everything below is doc-verified, not runtime-probed. Event payload shapes (message
parts, usage fields) are design-phase work (exec plan R1). Doc URLs are stable; re-fetch them when
the installed OpenCode version changes.

## Hard API break

V1 plugin implementations **do not run in V2**. V1 returned a hooks object keyed by strings
(`"tool.execute.before"`, `"chat.message"`, `event`, …). V2 is `Plugin.define({ id, setup(ctx) })`
with hooks registered on owning domains. Do not port v1 names; use the mapping table in the
migration doc when reading v1-era plugin examples (e.g. the user's `~/.config/opencode/plugins/*.js`
files, which are v1-format).

## Plugin shape (what we will build)

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-langfuse",
  async setup(ctx) {
    // register hooks/subscriptions; return cleanup for flush/shutdown
    return () => { /* flush + shutdown */ }
  },
})
```

- One dependency: `@opencode/plugin` (parts share its SDK).
- A plugin can be a single `.ts` file or a directory; directories with `package.json` use
  `exports`; without one, root files `server`/`index` (+`.ts/.tsx/.js`) are used.
- `setup` may return a cleanup function; hook/transform registrations are disposed at unload.
- Parts: server (`.`), TUI (`./tui`), GUI (`./gui-experimental`), RPC (`./rpc`). We need only the
  server part.

## Loading and discovery

- Auto-discovered: direct `.ts`/`.js` files and immediate package dirs under
  `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global). `.opencode/plugin/`
  is also tolerated for V2.
- `plugins` array in `opencode.json(c)`; relative paths resolve from the config file; local paths
  must be **directories**. Object form passes options: `{"package": "./plugins/x", "options": {...}}`
  → `ctx.options`.
- `-` prefix disables a plugin; `*` matches all; later entries re-enable. Two built-ins ignore
  removal.
- CLI: `opencode plugin add|list|check|update|remove` (package plugins; npm/Git specs supported).
- Hot reload: watched config dirs reload automatically; `opencode service restart` otherwise.

## Hook surface relevant to tracing (all verified in the server doc)

### Session hooks — `ctx.session.hook(name, cb, {providerID?}?)`

| Hook | Fires | Event carries |
| --- | --- | --- |
| `prompt` | once at prompt admission, before durable admission | mutable `prompt` (text/files/agents/skills), `metadata`, `delivery`; session/message IDs readonly |
| `context` | immediately before each agent-loop model request | `sessionID`, `agent`, `model`, `system`, `messages`, `options`, `tools` |
| `compaction` | checkpoint-summary requests | same as context + optional `result` to self-supply summary |
| `generate` | transient `ctx.session.generate` calls | same as context |
| `title` | title generation | request hook, no `agent`/`tools`; optional `result` |
| `model.request` | model request settings/headers | `headers`, same identity fields as HTTP hooks |
| `http.request` / `http.response` | every native provider HTTP exchange | `sessionID`, `agent`, `model`, `kind` (`"primary" \| "compaction" \| "title" \| "generate"`), request/response (bodies are one-shot streams — clone before reading) |
| `retry` | after a provider failure is classified | `error {type, message, status?}`, `attempt`, mutable `decision` |
| `experimental.ws.*` | WebSocket-streaming providers | frames as strings; names/shapes experimental |

`kind` is how auxiliary traffic (compaction/title/generate) is told apart from the primary agent
loop — the natural analogue of omp-langfuse's advisor role tagging.

### Tool hooks — `ctx.tool.hook(name, cb)`

- `execute.before`: `tool`, `input` (inspect/replace).
- `execute.after`: `status` `"completed" | "error"`; `result` on success (mutable), `error` on
  failure — the error-level source for tool observations.

### Event stream — `ctx.event.subscribe({ types?, signal? })`

Async-iterable public server event stream; filterable by `types` (e.g. `session.idle`,
`config.updated`); abort via the passed `signal` in the cleanup function. Event payload shapes are
**not yet probed** — R1 does this.

### Context reads relevant to tracing

- `ctx.session.get/context/list` — session info; full transcript (`context` returns
  `SessionMessageInfo[]`).
- `ctx.model.list/get` — active models; `Model.Info` includes `cost` tiers (units **unverified**;
  one doc example filters `model.cost.some(tier => tier.output > 20)`).
- `ctx.vcs` — repository information, working-copy status, file diffs (replaces manual git calls).
- `ctx.location` — `directory`, `workspaceID?`, `project {id, directory, canonical}`.
- `ctx.options` — options from the config object form.
- `ctx.storage` — durable JSON scoped by plugin `id` (`get/set/remove`).
- `ctx.generate.text` (experimental) — model calls outside a session; not needed for tracing.
- `ctx.command.transform` — register commands (editor `.add({name, description, execute})`);
  the OpenCode route for `/langfuse-status` / `/langfuse-test`.

## Loading-time notes for design

- Hooks run in plugin registration order; later hooks see earlier edits (observability plugins
  must not mutate anything — we only read).
- `prompt` hooks are retry-safe, not exactly-once; do not use admission as a counting boundary.
- `http.response` bodies are one-shot streams: to observe usage there we must tee the body without
  breaking the real consumer — a risk that pushes R1 to check the event stream first.

## Runtime-verified (probe, 2026-11-09, opencode 2.0.31)

A scratch probe plugin (`/tmp/r1-probe`, a plain-object export with no `@opencode/plugin` import —
loads fine) observed real sessions against a local OpenAI-compatible mock. Raw evidence:
`/tmp/r1-probe/out/` (runs 1–2: plain sessions; run 3: tool-failure path; run 4: tool-success path).

- Event stream types observed: `session.created`, `session.inbox.enqueued/delivered`,
  `session.instructions.updated`, `session.execution.started/succeeded`,
  `session.step.started/streamed/ended`, `session.text.started/delta/ended`,
  `session.tool.input.started/ended`, `session.tool.called`, `session.tool.progress`
  (non-durable, no `durable` seq), `session.tool.success`, `session.tool.failed`,
  `session.usage.updated`, `session.renamed`, plus registry notifications (`model.updated`,
  `provider.updated`, `plugin.updated`, …) and shell lifecycle (`shell.created`, `shell.exited`).
- **Usage surface (R1 decision):** `session.step.ended` fires once per model request with
  `{sessionID, assistantMessageID, finish, rawFinish, cost, tokens:{input, output, reasoning,
  cache:{read, write}}}`; `session.usage.updated` carries the same token shape cumulatively per
  session. Normalization observed: provider `prompt_tokens` split into `input` + `cache.read`;
  `completion_tokens` split into `output` + `reasoning`.
- **Host `cost` is 0 for unpriced models** (the mock model has no catalog price) — omp-langfuse's
  "never trust host cost" constraint carries over to OpenCode.
- Per-request attribution verified: one tool-loop session produced 2 × `step.started`/`step.ended`,
  one per provider request. The title request (`kind=title`) issues after `execution.succeeded`,
  produces **no step events**, and shows up only in the cumulative `session.usage.updated`.
- Tool lifecycle events are keyed by provider call `id` + `assistantMessageID`; failure carries
  `error {type: "tool.execution", message}`; success carries `content` parts and shell metadata;
  `shell.exited` is the exit-code signal (error-level source for non-zero exits).
- v2 tool names: `edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch,
  write, execute` (from the `context` hook's `event.tools`).
- `ctx.event.subscribe()`, `ctx.session.hook(...)`, `ctx.tool.hook(...)` all verified in-process;
  tee-ing `http.response` bodies and replacing the response with the kept branch does not break
  delivery.
- `session.idle` did **not** appear in `opencode run` sessions; `session.execution.succeeded` is
  the reliable completion signal. `session.error` / `retry` unexercised (no provider failure yet).

### R2 — model cost semantics (probe-verified)

- `ctx.model.list()` returns `{location, data: Model.Info[]}` — **not** a bare array.
- `Model.Info` keys: `id, modelID, providerID, family, name, compatibility, package, settings,
  capabilities, variants, time, cost, status, enabled, limit`.
- `cost` is a **tier array**: `[{input, output, cache: {read, write}}]` — config's flattened
  `cache_read/cache_write` normalize into `cache.*`. All 12 listed models (built-in `opencode`
  free provider) carry `cost: [{input: 0, output: 0, cache: {read: 0, write: 0}}]`.
- Units: **USD per 1M tokens** — confirmed by reproducing the host cost arithmetic exactly
  (mock model priced 1.5/9/0.15/1.25; tokens 37/5/2/5 → host cost `0.0001185`).
- Host cost formula (observed): `input×in + output×out + reasoning×out`; **`cache.read` is
  dropped** even when `cache_read` is priced. Never mirror the host formula.
- **Gap:** a config-defined provider's models do **not** appear in `model.list()` even while the
  provider serves traffic — the catalog read cannot be the only pricing source for configured
  providers (ADR-0002 records the layered resolution).

### R3 — subagent / child sessions (probe-verified)

- Subagent runs are **real child sessions**: `session.created` carries `parentID` (the parent
  session id), `agent` (subagent name, e.g. `"general"`), `title` (the task label), and the child
  emits its own `session.step.*`, `session.usage.updated`, and `session.execution.*` events.
- The `subagent` tool's input schema: `agent`, `description` (3–5 word label), `prompt`,
  `model` (providerID/modelID#variant; discouraged) + further properties (tail unverified:
  `sessionID`, `background` per the tool description).
- Foreground subagent flow observed end-to-end: parent requests subagent → child session created
  with parentID → child completes → parent continues with the tool result.

### R4/R5 — storage, env visibility, lifecycle (probe-verified)

- `ctx.storage.set/get` roundtrip works; values persist into OpenCode's central sqlite
  (`~/.local/share/opencode/opencode.db`, 0600, WAL-backed — found in `-wal` before checkpoint).
- The plugin process sees only the service-inherited environment: with no `LANGFUSE*` vars in
  the service env, `process.env` showed none. Env-based config therefore requires the vars to
  reach the service (export + `opencode service restart`) or a `--standalone`/`--server` run.
- Plugin lifecycle: `setup` ran once and survived seven `opencode run` sessions; the cleanup
  function ran on every config-dir reload (four observed), never between sessions — cleanup is
  an unload/reload hook, not a per-session boundary.

### Features 011–013 pinned surfaces (type-verified 2026-11-10, installed v2.0.31)

- `ctx.vcs.get({location:{directory}}, {signal?})` → `Promise<{location, data: Vcs.Info}>`;
  `RequestOptions` carries `signal?: AbortSignal`. `Vcs.Info` has **only**
  `provider?: string` and `branch?: {current?: string, default?: string}` — neither a remote
  URL, a commit id, nor a work-tree root. The default branch is not HEAD.
- `ctx.command.transform(cb: (editor: {add(definition): void}) => void): Promise<Registration>`.
  `CommandDefinition` is `{name, description?, execute(input: CommandInvocation):
  Promise<void>}`; `CommandInvocation` is `{sessionID, prompt, delivery}`. `execute` has **no**
  return-text/UI channel, and native execution of a command does **not** submit its invocation
  prompt (pinned core `command.ts`, v2.0.31) — prompting stays owned by the handler.
- `Session.Info` (from `ctx.session.get` / `session.created` data) is per-session:
  `location.directory` is an absolute path for the session's own location, `parentID?` is the
  direct parent session id, `agent?` is the session's agent name. `ctx.location` is the
  plugin-instance location and is **not** a substitute for a session's location.
- `session.created` child births carry `parentID`, `agent`, and `title` directly in `data`
  (R3), and children emit their own `session.step.*`/`session.execution.*` events.

