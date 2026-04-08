# Changelog

All notable changes to Agentic-Pi-Harness. Versioning follows SemVer.

## [0.1.0] — 2026-04-08

First tagged release. Tier A (runtime foundation) + Tier B (policy, hooks,
concurrency, replay drift detection) complete. CI green on all three jobs
(test / golden-path / replay-drift). 22 test files, 59 tests, tsc clean.

### Added — Tier A (runtime foundation)
- Zod schemas with `schemaVersion` for every persisted type
- Async-generator query loop with per-chunk retry and per-call `EffectScope`
- Mock model adapter for deterministic runs
- Effect recorder — per-call scopes, hash-before/hash-after + LCS-based unified diff + rollback confidence
- Hash-chained replay tape (`prevHash` / `recordHash` / framed canonicalization)
- Prompt-injection containment (`<tool_output trusted="false">` + ANSI/nested-tag/ctrl-char sanitization)
- Crash-safe writes (write-rename + fsync)
- CLIs: `doctor`, `run`, `verify`, `replay`, `what-changed`, `inspect`

### Added — Tier B (supervised runtime)
- `PolicyEngine` with full provenance (matched rules, winning rule, mode/manifest/hook influences)
- HMAC-SHA256 signed policy; worker-mode strict verification
- In-process hook dispatcher with per-hook timeouts and canonical audit digests
- Retry state machine with transient / rate-limit / context-overflow / fatal classification
- 4-strategy compaction (`drop_tool_output_bodies` → `summarize_text_deltas` → `drop_early_turns` → `hard_truncate`) with `CompactionRecord` audit trail
- Concurrency classifier — readonly parallel, serial per-name, exclusive drain
- Sub-agent git worktree isolation with escape guard
- Level B (effects) and Level C (decisions) replay-drift detection
- `LoopResult.events` vs `LoopResult.compactedEvents` split
- Real pi.dev provider seam with lazy import and chunk normalization
- `--trace` / `--trace=<path>` CLI flag; default `~/.pi/traces/latest.jsonl`

### Added — Release hygiene
- MIT LICENSE
- `.github/workflows/ci.yml` with test / golden-path / replay-drift jobs
- `scripts/compare-effects.mjs` path-agnostic determinism check
- Hash-chain microbench (env-aware: 2ms local, 6ms CI)
- Husky pre-commit schema-drift guard
- ADRs 0001 (scope tiering), 0002 (hash chain), 0003 (events vs compacted)
- `docs/`: GOLDEN-PATH, REPLAY-MODEL, PROMPT-ASSEMBLY, THREAT-MODEL, HOOK-SECURITY, SCHEMAS, EXECUTION-MODES, ARCHITECTURE-RUNTIME

### Known limitations (deferred to 0.2.0 / Tier C)
- Windows support (POSIX-only)
- OpenTelemetry metrics export (`src/metrics/counter.ts` is the swap point)
- Richer compaction strategies (semantic summarization, token-aware)
- Tier C decision-log equivalence (semantic diff of policy reasons)
