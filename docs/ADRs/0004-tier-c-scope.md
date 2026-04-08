# ADR 0004 — Tier C scope and deferrals

Status: accepted — 2026-04-08
Context: post v0.1.0 release, roadmap for v0.2.0

## Problem

v0.1.0 shipped the full Tier A + Tier B surface. Tier C was intentionally
deferred to keep the first release tight. Now we need to decide what goes
into 0.2.0 and what stays parked.

## Decision

Tier C is split into three named surfaces — each independently releasable.
Any one of them can ship without the others.

### C1 — Observability GA (0.2.0 target)
- OpenTelemetry metrics export: replace `src/metrics/counter.ts` in-memory
  counters with an OTel `Meter` + Prometheus scrape endpoint
- Structured logging via `pino`, one JSONL line per decision / retry / hook
  outcome, correlated by `sessionId`
- OTel traces for the query loop: root span per turn, child spans per
  tool call, retry, and hook dispatch
- Dashboards: p50/p99 per-turn latency, deny rate, retry rate, compaction
  rate, effect-record volume

### C2 — Decision-log equivalence (0.2.0 target)
- Level C today compares policy decisions by `toolCallId`, `result`,
  `winningRuleId`, `provenanceMode`. That catches most drift but misses
  *semantic* drift — two rule sets that deny the same set of calls for
  different reasons
- C2 adds a "semantic hash" per decision: canonicalized
  `{result, effect-class, surface-area}` independent of rule id
- Replay drift detection gains a `--semantic` flag that allows rule-id
  changes as long as the semantic hashes match

### C3 — Windows support (0.3.0 target, not 0.2.0)
- Path separators, signal handling, worktree cleanup all assume POSIX
- Sub-agent worktrees use `rm -rf` via node; Windows needs `rimraf`
- Crash-safe write uses `fsync`; Windows `FlushFileBuffers` semantics differ
- Deferred because the target deployment surface for 0.2.0 is Linux CI
  runners and dev Macs. Windows is real work, not a flag flip.

## Explicitly NOT in Tier C

- **Multi-agent orchestration.** Sub-agents today run in serial worktrees.
  Parallel sub-agents with merge conflict resolution is a v1.0 problem.
- **Distributed replay.** Tapes are single-machine files. A content-
  addressable replay store is a v2.0 problem.
- **Plugin marketplace.** Tier B ships an in-process hook API. A signed
  plugin registry with revocation is post-v1.0.

## Consequences

Pro:
- Each C-surface is independently shippable — if C2 is hard we still get C1
- Windows stays parked explicitly instead of half-done
- The observability surface lands before the semantic diff, so we can
  actually *measure* whether semantic drift detection fires in production

Con:
- Three surfaces means three release candidates instead of one
- OTel adds a runtime dep (first one besides zod); documented in 0.2.0
  changelog
