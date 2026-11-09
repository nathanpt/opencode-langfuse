# Decision records

MADR-style records for decisions that constrain future work: architecture, interfaces, data
storage, security, deployment, dependencies, or major user-visible behavior. Read the relevant
ADRs before changing a decision they constrain.

## Conventions

- File name: `NNNN-title-with-dashes.md`, zero-padded, monotonic. Never renumber.
- Status line at the top: `proposed` → `accepted` → (`deprecated` | `superseded by NNNN-…`).
- When a decision changes, keep the old file and create a new one that supersedes it. Do not
  rewrite decision history.
- Keep ADRs short: context, drivers, options, decision, consequences, confirmation evidence.

## Template

```markdown
# NNNN. Title

- Status: proposed | accepted | deprecated | superseded by NNNN
- Date: YYYY-MM-DD

## Context

What problem forces a decision; relevant constraints and prior evidence (link reference docs).

## Decision drivers

- …

## Considered options

1. … — pros/cons
2. … — pros/cons

## Decision

Chosen option and why, in one or two sentences.

## Consequences

What becomes easier, what becomes harder, what is rejected, what remains open.

## Confirmation

How/when we will know the decision holds (probe, test, live evidence).
```

## Index

| ADR | Title | Status |
| --- | --- | --- |
| 0001 | Config & credential storage | accepted |
| 0002 | Usage capture & cost computation | accepted |
