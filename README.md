# opencode-langfuse

Langfuse observability plugin for [OpenCode](https://opencode.ai) v2.

Sends one Langfuse trace per OpenCode session: a root observation (user prompt → final assistant
response), one generation per model request with self-computed token usage and cost, one tool
observation per tool call (failures marked), content-free compaction spans, and cumulative
trace-level scores — all filtered through privacy presets and a redactor. Child subagent
sessions get their own traces, linked to the parent.

Derived from [omp-langfuse](https://github.com/nathanpt/omp-langfuse) (the same idea for the OMP
harness), ported to the OpenCode v2 plugin API (`Plugin.define` from `@opencode/plugin`).

**Status:** released — [v0.0.1](./CHANGELOG.md). Verified against OpenCode v2.0.31. The full
surface is documented in [ARCHITECTURE.md](./ARCHITECTURE.md), the ADRs under
[docs/decisions/](./docs/decisions/), and the verified API notes in
[docs/references/opencode-plugin-api.md](./docs/references/opencode-plugin-api.md).

## Install

```sh
opencode plugin add https://github.com/nathanpt/opencode-langfuse.git
```

Pin a release by appending the tag: `...#v0.0.1`. The install lands in the global config's
`plugins` array and the package is cached under `~/.cache/opencode/npm/`; restart OpenCode
afterwards. Verify with `/langfuse-status` in any session (see below).

The bundle is self-contained — no build step and no dependencies on the consumer side.

## Configuration

Credentials never belong in a repo. Two sources, env wins over file:

1. **Environment** — `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (both required together),
   `LANGFUSE_BASE_URL` (or legacy `LANGFUSE_HOST`).
2. **File** — `~/.config/opencode-langfuse/config.json` (recommended `0600`):

   ```json
   {
     "publicKey": "pk-lf-…",
     "secretKey": "sk-lf-…",
     "host": "https://your-langfuse.example.com",
     "privacyPreset": "metadata-only",
     "pricing": {
       "providerID/model.id": { "input": 1.5, "output": 9, "cacheRead": 0.15, "cacheWrite": 1.25 }
     }
   }
   ```

Unconfigured, the plugin stays honestly disabled: it loads, reports why, and sends nothing.

### Privacy presets

`privacyPreset` (or `LANGFUSE_PRIVACY_PRESET`): `metadata-only`, `prompts-only`,
`conversations`, `full-debug`. Per-field overrides:
`LANGFUSE_CAPTURE_INPUTS`, `LANGFUSE_CAPTURE_OUTPUTS`, `LANGFUSE_CAPTURE_TOOL_IO`,
`LANGFUSE_CAPTURE_SYSTEM_PROMPT`, `LANGFUSE_CAPTURE_CWD`. Numeric facts (usage, cost, scores,
statuses, ids) survive every preset; content that is off is absent, not empty. Every emitted
string passes the redactor.

### Cost

Cost is always **self-computed** from each request's own token usage — never the host's number,
which drops cache terms. Price resolution picks exactly one source, never a mix:

1. config override (exact `providerID/model.id` key, USD per million tokens),
2. the native model catalog, selecting the cost tier by context threshold
   (`input + cacheRead + cacheWrite` against `tier.size` — context-tiered models priced
   correctly; below every threshold the base tier applies),
3. a bundled published-rate table (approximation flagged, e.g. DeepSeek off-peak),
4. nothing — cost omitted, one warning per model.

### Trace metadata

Each trace records source/git identity (`git_branch`, `git_commit`, sanitized remote identity)
with per-repo overrides via `<repo-root>/.opencode-langfuse.metadata.json`. A parent session's
subagents produce separate `opencode-subagent:<agent>` traces under the same Langfuse session id.

### Scores

Five cumulative scores per trace — `tool_call_count`, `turn_count`, `total_tool_errors`,
`tool_success_rate`, `session_had_errors` — published only on native session terminals and only
when complete history is provable (a compacted cold restore suppresses updates rather than
guessing).

## Operational commands

- `/langfuse-status` — resolved state: credentials source, host (redacted), effective preset and
  capture flags, last runtime error.
- `/langfuse-test` — one standalone ingest round-trip (`opencode-langfuse-test` trace); never
  touches the session trace.

Both are server-log-only: no model calls, no transcript changes.

## Requirements

- OpenCode v2 with the plugin API v2 (verified on v2.0.31).
- A reachable Langfuse (cloud or self-hosted) when tracing is enabled.

## Development

```sh
npm run typecheck && npm test && npm run bundle
```

`npm test` is a deterministic node:test suite under `test/` (no network). The bundle lands in
`dist/index.js`; drop it into a project's `.opencode/plugins/` to try it against a real
Langfuse. Live verification of trace-path changes follows the levels in
[ARCHITECTURE.md](./ARCHITECTURE.md); the routed documents are `AGENTS.md` (router),
`ARCHITECTURE.md`, `docs/decisions/` (ADR-0001…0005), `docs/references/`, and
`docs/feature-list.json`.

## License

[MIT](./LICENSE)
