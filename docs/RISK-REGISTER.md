# Risk Register — v0.1.0

Operational risks for the harness as-shipped. Scored Likelihood × Impact on
a 1–5 scale; mitigations map to existing code or roadmap items.

| ID | Risk | L | I | Score | Owner | Mitigation |
|----|------|---|---|-------|-------|------------|
| R1 | Tape hash chain corruption goes undetected | 1 | 5 | 5 | runtime | ADR 0002 hash chain, `verify` CLI, `chaos/tapeCorruption.test.ts` (4 tests) |
| R2 | Sub-agent worktree escape writes to parent repo | 1 | 5 | 5 | runtime | `E_WORKTREE_ESCAPE` guard, `worktreeIsolation.test.ts` (2 tests) |
| R3 | Worker mode accepts unsigned policy | 1 | 5 | 5 | runtime | HMAC strict check, `workerModePolicy.test.ts` (4 tests) |
| R4 | Prompt-injection via tool output escapes sandbox | 2 | 4 | 8 | runtime | `<tool_output trusted="false">` wrap + ANSI/nested-tag/ctrl-char strip, `promptAssembly.fuzz.test.ts` (200 iters) |
| R5 | Concurrent writes to same path clobber pre-hash | 2 | 4 | 8 | runtime | Per-call `EffectScope`, `loopConcurrentWrites.test.ts` |
| R6 | Retry loop double-writes tape on transient error | 1 | 4 | 4 | runtime | Manual `iter.next()` wrap, `loopRetry.test.ts` |
| R7 | Compaction mutates in place, tape diverges from memory | 1 | 4 | 4 | runtime | ADR 0003, immutable `LoopResult.events` |
| R8 | Hook timeout stalls turn | 2 | 3 | 6 | runtime | Per-hook `withTimeout`, `hooksConcurrency.test.ts` |
| R9 | Hash-chain latency regresses on slow CPUs | 3 | 2 | 6 | runtime | `hashChain.bench.test.ts` env-aware (2ms local / 6ms CI) |
| R10 | Replay drift between two runs not caught in CI | 2 | 4 | 8 | ci | `.github/workflows/ci.yml` replay-drift job, `scripts/compare-effects.mjs` path-agnostic |
| R11 | Signed policy key leaks via process env | 2 | 5 | 10 | ops | Documented in HOOK-SECURITY.md — keys loaded from env, rotated via normal secret rotation |
| R12 | Dependency (zod) vulnerability | 2 | 3 | 6 | ops | Only one runtime dep; `npm audit` on CI (not yet wired — add in 0.1.1) |
| R13 | Deterministic replay breaks under non-POSIX filesystems | 3 | 3 | 9 | runtime | Documented POSIX-only in README; Windows deferred to ADR 0004 C3 |
| R14 | Compaction eats a decision that should have persisted | 2 | 3 | 6 | runtime | `CompactionRecord` audit trail; compaction is pure, never mutates tape |

## Top 3 to watch in 0.2.0

1. **R11** (key leaks) — no programmatic check exists. Add a pre-commit
   guard that refuses to commit files matching `*.key` or `*.pem`.
2. **R13** (filesystem assumptions) — won't surface until someone tries it
   on NTFS. Add a Windows smoke CI job before Tier C C3 lands.
3. **R12** (deps) — trivial to wire `npm audit` into CI. Do in 0.1.1 patch.
