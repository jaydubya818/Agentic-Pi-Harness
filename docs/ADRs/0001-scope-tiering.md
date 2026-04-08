# ADR 0001 — Scope Tiering (Tier A / B / C)

**Status:** accepted — 2026-04-08
**Deciders:** jay
**Supersedes:** —

## Context

v4 of the plan carried a monolithic "must ship in v0.1" list that, on inspection, contained both plumbing (schemas, recorders, loop) and visible product surface (CLI, docs, golden-path demo). A single Tier A risked being "complete on paper but invisible in product" — everything compiles, nothing demos.

## Decision

Split scope into three tiers:

- **Tier A — required for v0.1.** Further split into:
  - **A-runtime** — schemas, loop, effect recorder (minimum spec), replay recorder with hash chain, prompt-injection containment, placeholder policy decisions, crash-safe writes, provenance manifest.
  - **A-proof** — the golden path scenario end-to-end: `run`, `verify`, `replay`, `what-changed`, `inspect`, plus one hand-written golden tape and Level-A replay-drift CI. v0.1 is not done until A-proof runs clean.
- **Tier B — required before autonomous/worker mode.** Permission engine, signed policy, hooks beyond in-process, sub-agent worktrees, compaction, retry state machine, streaming concurrency classes, Level-B+C replay determinism.
- **Tier C — post-v0.1.** Multi-provider adapters, plugin marketplace, OpenTelemetry, Windows support, MCP hosting, remote attestation.

Every task is tagged with its tier. PRs that add Tier B/C scope without completing Tier A are blocked.

## Consequences

- **Positive.** Clear finish line. The Week-2 golden-path gate is enforceable. Scope creep is detected at review time, not at demo time.
- **Positive.** A-runtime/A-proof split prevents the "plumbing without product" failure mode.
- **Negative.** Some architecturally interesting work (signed policy, sub-agents) is deferred. This is deliberate — those belong behind autonomous mode, not in front of it.
- **Negative.** The tier labels add review overhead. Mitigated by making the tier a required field in the PR template.

## Alternatives considered

1. **Single v0.1 list.** Rejected — v4 already showed this drifts into "everything is P0."
2. **Feature flags instead of tiers.** Rejected — flags hide incompleteness from the build; tiers make it visible.
3. **Time-boxed milestones without tiers.** Rejected — time-boxing without a scope contract just pushes work over the edge.
