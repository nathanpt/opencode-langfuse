# opencode-langfuse

Langfuse observability plugin for [OpenCode](https://opencode.ai) v2.

Sends one Langfuse trace per OpenCode session: a root observation (user prompt → final assistant
response), one generation per model request with self-computed token usage and cost, one tool
observation per tool call (failures marked), compaction spans, and trace-level scores — all
filtered through privacy presets and a redactor.

Derived from [omp-langfuse](https://github.com/nathanpt/omp-langfuse) (the same idea for the OMP
harness), ported to the OpenCode v2 plugin API (`Plugin.define` from `@opencode/plugin`).

> **Status:** pre-implementation. The operating foundation and research references exist; the
> design is being drafted and no code exists until the operator approves it. Start at
> [ARCHITECTURE.md](./ARCHITECTURE.md), then
> [docs/exec-plans/active/](./docs/exec-plans/active/).
