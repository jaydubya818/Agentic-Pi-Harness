# Changelog

All notable changes to Agentic-Pi-Harness. Versioning follows SemVer.

## [0.4.0] — 2026-04-18

Maintenance + perf release. Toolchain aligned with `@mariozechner/pi-coding-agent` v0.67.68. 53 test files, 159 tests, tsc clean, zero audit findings.

### Changed
- **Toolchain bump to match latest Pi stack** — TypeScript `5.4` → `5.7.3`, Vitest `1.4` → `3.2.4`, `@types/node` → `^20.17`, `tsx` → `^4.19`. Removed 4 moderate-severity vulnerabilities reported by `npm audit`.
- **Lazy Pi import renamed** — `piDevProvider.ts` now imports `@mariozechner/pi-ai` instead of the legacy `pi` package name. Still an optional, deferred import (Tier B); the harness builds and tests without it. Install with `npm install @mariozechner/pi-ai` when activating a real provider.

### Performance
- **Tape writer is now append-only** — `ReplayRecorder.writeEvent()` previously rewrote the entire tape file with a tmp+rename+fsync dance on every event (O(N²) bytes). It now keeps an `O_APPEND` file handle open and appends + fsyncs each record, reducing per-event work to O(record size). The header still uses the atomic write-rename path so the initial file is crash-safe.
- **Streaming frame hash** — new `sha256HexFramed(frame, value)` in `src/schemas/canonical.ts` feeds the frame tag, newline separator, and canonical JSON directly into a single `createHash("sha256")` call, avoiding the intermediate `Buffer.from(frame + "\n" + canonical)` allocation.
- **Bench impact** — `tests/bench/hashChain.bench.test.ts` (N=2000): p50 `2.115ms` → `0.21ms` (~10×), p99 `5.97ms` → `0.37ms` (~16×). Full suite runtime `7.48s` → `2.55s`.
- Hash-chain digests are identical to 0.3.x — the committed `goldens/canonical/` artifacts verify and replay unchanged.

### Added
- **End-to-end integration tests** — `tests/unit/runVerifyReplay.e2e.test.ts` drives `runGoldenPath` → `verifyTape` → `readTape` and checks tape/effect/policy/checkpoint outputs from scratch. Fills the run→verify→replay gap previously only covered at the unit level.
- `ReplayRecorder#close()` — explicit close for the append file handle. Called by the CLI in a `finally` block so crashes during a run don't leak the handle.

### Fixed
- Eliminated a file-handle leak path: writers that re-used a `ReplayRecorder` across headers now close the prior handle before opening the new one.

## [0.3.0] — 2026-04-08

Tier C continued. 28 test files, 84 tests, tsc clean. Zero new runtime deps. Windows support explicitly deferred.

### Added
- **Real pi.dev provider factory** — `createDefaultModelClient(fallbackScript)` in `src/adapter/defaultClient.ts` returns a `PiAdapterClient` wrapping `PiDevProvider` when `PI_HARNESS_PROVIDER` + `PI_HARNESS_MODEL` env vars are set; otherwise returns `MockModelClient`. Single choke point for mock-vs-real.
- **Cost tracking** — `src/metrics/cost.ts` with `CostTable`, `CostTracker` (observes `text_delta` as output tokens, `tool_result` as next-turn input tokens, 4-chars-per-token heuristic), `CostRecord`. `LoopInputs.costTable?` wires it in; `LoopResult.cost: CostRecord | null`; counters gain `cost.inputTokens`, `cost.outputTokens`, `cost.micros_usd`.
- **PolicyEngine rule inheritance** — rules may `extends: "<parentId>"`; child inherits parent's `match` + `action`, then overrides field-by-field. Resolution runs at engine construction; cycles raise `E_POLICY_CYCLE`. `getResolvedRules()` exposes the merged view for tests/debug.
- **Shell-contract hook executor** — `src/hooks/shellHook.ts` spawns an external process, writes `{event, sessionId, turnIndex, payload}` JSON to stdin, reads a `HookResponse` from stdout, hard SIGKILL timeout. Non-zero exit or invalid JSON raises `E_HOOK_SHELL`. Lets hooks be written in any language.
- New error codes: `E_POLICY_CYCLE`, `E_HOOK_SHELL`.

### Changed
- `PolicyRule.match` and `PolicyRule.action` are now optional (inheritance can fill them in).
- `LoopResult` gains `cost: CostRecord | null`.

### Deferred (C3)
- Windows support (path handling, worktree isolation, `windows-latest` CI job).

## [0.2.0] — 2026-04-08

Tier C (observability + semantic determinism). CI green on c175756. 24 test files, 70 tests, tsc clean.

### Added
- **OpenTelemetry meter swap-in** — `createOtelCounters()` in `src/metrics/otel.ts` (lazy `@opentelemetry/api` peer import; throws `E_OTEL_UNAVAILABLE` if missing). `CountersSink` interface + `FanOutCounters` in `src/metrics/counter.ts` for multi-sink delegation. `LoopInputs.counters?: CountersSink` wires it into the query loop.
- **Structured logging** — `src/obs/logger.ts` with `Logger` interface, `NoopLogger`, `JsonLogger` (stdout JSON-line + child bindings), and `createPinoLogger()` lazy peer-import adapter (throws `E_LOG_UNAVAILABLE`).
- **Semantic decision drift** — `src/policy/semanticHash.ts` computes `sha256-semantic:` fingerprint over `{result, toolName, effectClass}` (rule-rename-invariant). `classifyEffect()` maps tool name + input shape to read-path / write-path / exec / net / other. `scripts/compare-decisions.mjs --semantic` runs in CI alongside the exact comparison.
- **`npm audit --audit-level=high`** gate in CI test job (risk R12 from the register).
- `PiErrorCode`: `E_OTEL_UNAVAILABLE`, `E_LOG_UNAVAILABLE`.

### Changed
- `Counters` now implements `CountersSink`; behavior unchanged.
- Runtime deps still just zod. OTel and pino remain optional peers.

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
