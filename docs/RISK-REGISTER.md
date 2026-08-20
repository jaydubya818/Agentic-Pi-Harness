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
| R9 | Hash-chain latency regresses on slow CPUs / slow storage | 3 | 2 | 6 | runtime | `hashChain.bench.test.ts` opt-in env-aware ceiling (`PI_HASHCHAIN_BENCH_CEILING_MS`, defaults 12ms local / 16ms CI) |
| R10 | Replay drift between two runs not caught in CI | 2 | 4 | 8 | ci | `.github/workflows/ci.yml` replay-drift job, `scripts/compare-effects.mjs` path-agnostic |
| R11 | Signed policy key leaks via process env | 2 | 5 | 10 | ops | Documented in HOOK-SECURITY.md — keys loaded from env, rotated via normal secret rotation; `scripts/check-secrets.mjs` pre-commit guard refuses staged key material and literal credentials (`checkSecrets.test.ts`) |
| R12 | Runtime dependency vulnerability | 2 | 3 | 6 | ops | Two runtime deps (`zod`, and `node-pty`, a native module that allocates PTYs); both pinned to exact versions; `npm audit --audit-level=high` runs on every CI `test` job |
| R13 | Deterministic replay breaks under non-POSIX filesystems | 3 | 3 | 9 | runtime | Documented POSIX-only in README; Windows deferred to ADR 0004 C3 |
| R14 | Compaction eats a decision that should have persisted | 2 | 3 | 6 | runtime | `CompactionRecord` audit trail; compaction is pure, never mutates tape |
| R15 | Local process or browser page drives the Hermes bridge | 3 | 5 | 15 | ops | `/sessions` + `/execute` spawn workers, so loopback is reachability and not authentication: `start()` refuses a non-loopback bind without a token and refuses a blank token, `Host` must be loopback, any request carrying `Origin` is rejected (`hermesBridge.test.ts`). Residual: anything running as the same OS user can still call the bridge, and `--auth-token` is visible in `ps` |

## Top 3 to watch in 0.2.0

1. **R11** (key leaks) — a pre-commit guard now refuses staged key material
   (`*.pem`, `*.key`, `id_rsa`, a real `.env`) and self-identifying
   credentials in staged content. It cannot see a key that only ever lives
   in the environment, which remains the residual risk.
2. **R13** (filesystem assumptions) — won't surface until someone tries it
   on NTFS. Add a Windows smoke CI job before Tier C C3 lands.
3. **R15** (bridge reachability) — the header checks stop a browser, not a
   local process. Same-user isolation needs either a mandatory token by
   default or a unix-socket transport; decide before the bridge is anything
   but an operator-launched foreground process.
