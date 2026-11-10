Start every reply with "Skipper,". No exceptions.

# AGENTS.md — opencode-langfuse

## Part 1 — Project

### What this is

Langfuse observability plugin for [OpenCode](https://opencode.ai) v2. One Langfuse trace per
OpenCode session: a root observation for the user prompt and final response, one generation per
model request with self-computed cost, one tool observation per tool call (failures marked),
compaction spans, and trace-level scores — all filtered through privacy presets and a redactor.
Derived from the sibling plugin `omp-langfuse` (`~/dev/projects/omp-langfuse`, same idea for the
OMP harness), ported from OMP's extension API to the OpenCode v2 plugin API.

**Status: pre-implementation.** Only research and design documents exist. The operator must
approve the design before any implementation code is created.

### Environment

- OpenCode **v2.0.31** installed (`opencode` on PATH). Verified plugin API surface:
  `docs/references/opencode-plugin-api.md`.
- Target API: plugin API **v2** — `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`.
  V1 plugin implementations do not run in v2; never port v1 hook names or shapes.
- Language/runtime: TypeScript, bundled with esbuild (pattern proven in omp-langfuse). Exact
  typecheck/test/build tooling is set up with the first approved implementation slice.

### Commands

```bash
opencode --version        # installed CLI version (expect v2.x)
opencode plugin list      # plugins active for this project
opencode run "..."        # one-shot session; used for live verification
```

Plugin dev loop: place the plugin under `.opencode/plugins/` (auto-discovered) and restart, or
reference it from `opencode.json(c)`'s `plugins` array; `opencode service restart` reloads watched
config dirs. Verification: `npm run typecheck && npm test && npm run build` (tsx node:test
suite under `test/`, esbuild node22 bundle to `dist/index.js`).

### Hard constraints

1. Do not create implementation code until the operator approves the design (current gate).
2. Trace cost is computed from token usage × a resolved price. Never trust host-reported cost
   without proving it correct for the model (omp-langfuse lesson; unverified for OpenCode).
3. Every captured payload passes the redactor; privacy presets govern whether it is captured at all.
4. Credentials never enter the repo or the traces. Env vars or a 0600 config file outside the repo.
5. Any change to the trace path (hook → observation → Langfuse mapping) is verified against a live
   Langfuse before it can be marked passing (see Verification in ARCHITECTURE.md).
6. Use only the v2 plugin API surface documented in docs/references/opencode-plugin-api.md.

### Routing

- Read ARCHITECTURE.md before changing the trace path, transport, or component boundaries.
- Read docs/feature-list.json before selecting the next feature; work one feature at a time.
- Read docs/references/opencode-plugin-api.md before using or arguing about a hook, event, or
  context API.
- Read docs/references/omp-langfuse-reuse-inventory.md before reimplementing something the sibling
  already solves (pricing layers, redaction, presets, flush lifecycle, scores).
- Read docs/references/event-architecture-omp-vs-opencode.md before changing the acquisition or
  observation layer (event semantics, ordering, buffering, flush).
- Read docs/exec-plans/active/ when continuing planned work.
- For decisions that affect architecture, interfaces, data storage, security, deployment,
  dependencies, or major user-visible behavior, create or update an ADR in docs/decisions/. Read
  relevant existing ADRs before changing a decision they constrain.
- Run the applicable verification level before marking work complete.

## Part 2 — Standard rules (all projects)

<!-- BEGIN STANDARD RULES v1.2 — identical across all projects; do not edit in place -->
### Planning

Before writing code, state the plan abstractly: what the system does, which
boundaries the change crosses, what data moves and in which direction, and what
would prove the change works. Do not enumerate implementation steps as a
substitute for understanding the shape of the problem.

Do not attempt to one-shot a multi-part task; half-finished work left behind is
worse than unstarted work.

### Testing

Tests exist to catch regressions, not to raise a coverage number.

- A test added to verify new behavior must fail when that behavior is absent.
- Every test names the behavior or regression it protects, in its name or its
  message.
- Prefer observable-behavior tests; test internal logic, private helpers, or
  framework interaction when they carry a specific correctness risk.
- Do not mock away the behavior under test.

### End-to-end verification

Unit tests are systematically blind to component-boundary defects: interface
mismatches, state propagation, resource lifecycle, and environment differences
all survive a green unit suite.

Run the checks the project defines for the change: unit, then integration, then
end-to-end through the real system when the change crosses a component or
user-visible boundary.

Record the exact command and the observed result. "Should work" is not evidence.

### Invariants and boundaries

- Control boundaries, data shapes, and dependency direction; leave the internals
  to the implementer.
- Parse data at the boundary. Never build on a guessed shape from an external
  system, an untyped payload, or a library's undocumented behavior.
- Encode mechanically checkable invariants in tests or lint rules, with
  actionable failure messages.
- Follow the best pattern already in the repository, not merely the nearest one.
  Agents copy whatever they see first, including the bad example.

### Change discipline

- Before adding code or scaffolding, inspect the relevant paths and ask whether
  the requested outcome can be met by deleting, reusing, configuring, or
  extending something already present.
- Check existing implementations, platform facilities, standard-library
  functions, and installed dependencies before adding new code or dependencies.
- Implement the smallest complete change that satisfies the requirement. Do not
  add speculative abstractions, generality, files, or configuration.
- Do not reduce validation, error handling, security checks, accessibility,
  tests, observability, or readability merely to reduce lines.

### Session discipline

- Start by reading `PROGRESS.md` — the active-work, blockers, verification-status,
  and next-move sections, not the whole file — then the recent git log. Reading
  the entire file wastes context; read the sections that decide what to do now.
- Then run the baseline checks and record any pre-existing failures. Do not begin
  by writing code.
- Work on one bounded unit at a time, selected from the feature list when the
  project has one.
- Only a passing verification moves a feature to done. Never weaken acceptance
  criteria or delete a test to make progress look better.
- At handoff, record what changed, the verification results, and what is
  unfinished in the progress file. Commit only when the project workflow or the
  user asks for it.
- Before handoff, list what the change made untrue and update every document
  that describes it — module maps, invariants, contracts, verification
  baselines. A routed document must never describe retired behavior or a
  superseded baseline.
- If `CHANGELOG.md` exists, add each user-visible change to `## Unreleased`
  under Added, Changed, or Fixed in the same session. Set versions and dates
  only at release; never edit an entry that has shipped.

### Verification errors

Failure reports state what failed, its impact, and either a known fix or the next
diagnostic step. Label uncertain causes rather than inventing a remedy.

### Completion

Never report work as complete, done, passing, or shipped on the strength of code
that was not executed. Distinguish implemented from verified. Report complete or
passing only when the applicable required checks have run and passed; otherwise
state what remains unverified and what evidence would close it.

End any turn that reports on long-running or delegated work with a short status: **Goal**, **Done**, **Next**, **Docs**, **Needs you** (or "nothing"). **Docs** names the routed documents this change updated, or states that no routed document describes it.

### Instruction hygiene

Keep AGENTS.md a short router to topic documents: check the combined Part 1 and
Part 2 against the roughly 200-line budget, with hard constraints under 15.

- A new rule goes into a topic document unless it is a genuine red line.
- Do not restate what the code, types, or config already say.
<!-- END STANDARD RULES -->
