# Changelog

All notable changes to Agentic-Pi-Harness. Versioning follows SemVer.

## [Unreleased]

### Fixed
- The `script(1)` PTY transport passed BSD-style arguments on every platform; util-linux `script` ignores extra positional arguments, so on Linux it spawned an interactive shell, never ran the worker command, and reported exit 0 with empty output. Linux now uses `script -qefc '<quoted command>' /dev/null` (exit code propagated, output flushed); BSD/macOS behavior is unchanged.
- `POST /cancel` and `POST /interrupt` resolved the execution to a run but then signalled the run's *session*, i.e. whatever execution is currently active on it. Cancelling an already-finished run could SIGTERM an unrelated execution reusing the session. Terminal runs now return 409, and `adapter.cancel`/`interrupt` accept an execution id and no-op on mismatch.
- Worker timeouts are classified as v2 state `timed_out` / failure class `timeout` instead of `execution_error` (or `contract_error` when the SIGTERM'd worker never printed its structured result block). `HermesTaskResult` and the terminal adapter event carry a `timed_out` flag.
- Runs restored from bridge state after a restart no longer report `accepted`/`running` forever; with the worker process dead alongside the old bridge, they are marked failed (`transport_error` for v2 runs) with an explicit bridge-restart error.
- `HermesBridgeServer.stop()` cancels in-flight executions before draining watchers instead of blocking shutdown until the worker finished or hit its timeout budget (900s default).
- Policy `pathPrefix` rules are segment-aware: `"tests"` no longer matches `tests-evil/x.ts` or `tests.bak`, closing an approve-rule leak onto sibling paths sharing leading characters.
- A stale cancel force-kill timer could SIGKILL the *next* execution on the same session: the timer re-read `session.active` when it fired, and a double cancel (or the timeout path) orphaned the previous timer so exit cleanup never cleared it. The timer now captures the execution being cancelled and pending force-kill timers are cleared before a new one is armed.
- `read_events` iterators no longer hang forever when their session is closed mid-iteration; closed sessions set a flag that drained generators observe instead of re-parking on a waiter nothing can wake.
- Raw worker output retained in memory for end-of-run parsing is capped at an 8M-char tail (configurable via `maxRetainedOutputChars`); the full stream still lands in `hermes.raw.log`. Previously a chatty long-running worker grew the harness heap without bound.
- `POST /sessions` with a missing or empty `workdir` returns 400 instead of reaching `start_session(undefined)` and surfacing as an unhandled 500; `/interrupt` and `/cancel` now reject non-string `execution_id` bodies with 400.
- v2 result envelopes' `logs_ref.bridge_state_root` pointed at the hardcoded default `~/.pi/hermes-bridge-state` even when the bridge ran with a custom `stateRoot`; the configured root is now threaded through.
- Sub-agent slugs are allowlisted before they become filesystem path segments and `pi/<slug>-<ts>` branch names; traversal (`../evil`), nested (`a/b`), and git-ref-syntax slugs are rejected, and the worktree base check is boundary-safe instead of a raw `startsWith`.
- A missing or non-executable Hermes command no longer crashes the harness with an unhandled `'error'` event from the spawned child; both stdio transports surface spawn failures as a single exit event with code 127.
- The shell hook hard timeout now SIGKILLs the hook's whole process group (POSIX), so hung descendants die with the hook as the contract comment always promised; shell hook stdout/stderr capture is bounded at 4MB per stream.
- `runTaskViaBridge` no longer aborts a still-executing governed run because one `/runs` poll returned a non-2xx or non-JSON response; polls retry until the deadline and raw event capture is best-effort once the result exists.
- The effect recorder caps its LCS diff at a 4M-cell budget; a rewrite of a huge text file records pre/post hashes plus a `[diff omitted]` marker instead of allocating an O(n·m) table that could OOM the harness.
- Transport output is decoded with a per-stream `StringDecoder`, so a multi-byte UTF-8 character split across pipe reads no longer reaches the adapter as U+FFFD replacement characters.
- Hook timeout races (`hooks/dispatcher.ts`, `hooks/mediation.ts`) clear the losing timer instead of keeping the event loop alive for up to `timeoutMs` per hook call, and a hook that rejects after losing the race no longer surfaces as an unhandled rejection.
- Worker-mode `allowedWritePathPrefixes` matching is now normalized and boundary-aware: sibling directories sharing a string prefix (`sandbox-evil/` vs `sandbox`) and traversal escapes (`sandbox/../src/x`) are denied.
- Client-supplied `execution_id` values are preflight-denied by `/execute` unless they are safe single path segments; the bridge state store also refuses unsafe session/execution segments, closing a path traversal out of the state root.
- One corrupt line in `preflight-denials.jsonl` (e.g. a crash mid-append) no longer makes `loadPreflightDenials` silently return an empty list; corrupt lines are skipped individually.
- Create-mode knowledge writes open with `O_EXCL` (`wx`), so a file that appears between the policy existence check and the write fails with `EEXIST` instead of silently overwriting create-only queue items, traces, or immutable requests.

- Trace files can no longer be truncated by an explicit create-mode write to an existing append-only trace path; the write now fails closed with `kb.trace_overwrite_denied`.
- Knowledge-root containment no longer misclassifies legal dot-dot-prefixed names (e.g. `..weird.md`) directly under a root as outside it.
- Stuck-run detection compares against the last observed worker progress/output event instead of the supervisor's own emitted heartbeats. Previously a hung worker was never flagged with heartbeats enabled (the default), and every run older than `stuckTimeoutMs` was killed with them disabled even while actively streaming.
- Shell hooks that exit before reading their stdin payload no longer crash the harness with an unhandled `EPIPE`; the hook promise settles from exit code + stdout as intended.
- `wrapToolOutput` escapes quote/angle-bracket characters in the `tool` and `id` attributes so a hostile tool identity cannot break out of the untrusted `tool_output` envelope or forge `trusted="true"`.
- `runTaskViaBridge` checks the `/sessions` HTTP status and fails fast with the response body instead of surfacing a missing `session_id` later as an unrelated error.
- Hermes adapter output chunks are handled strictly in order (serialized per execution); concurrent chunk handlers could previously interleave raw-log appends and reconstruct line boundaries out of order.
- Hermes deletes outside both knowledge roots are now denied (previously fell through every guard to an unconditional `unlink`).
- Append-mode knowledge writes use a true `O_APPEND` append instead of read-whole-file + truncate-and-rewrite, so a crash mid-append can no longer lose an entire trace.
- `promoteKnowledgeCandidate` fails fast if the canonical target or approval record already exists instead of silently overwriting promoted knowledge.
- `writeKnowledgeJson` emits `kb.queue_create` for queue creates, matching `writeKnowledgeText` in the policy audit stream.
- Bridge bearer-token auth uses `crypto.timingSafeEqual`; request bodies are capped at 4MB (413) and malformed JSON returns 400 instead of a logged-as-unhandled 500.
- `requestApprovalDecision` clears its timeout timer, aborts the requester's `AbortSignal` on timeout, and no longer misclassifies a human deny whose reason is literally "approval timeout" as a system timeout.
- `semanticDrift` now reports tool calls present in only one of the two decision logs instead of silently ignoring calls that appear only in the replayed log.
- Worker-mode `allowedWritePathPrefixes` now fails closed when a write input yields no extractable paths (previously the vacuous `every()` allowed the write through).
- `loadPolicy` wraps malformed policy JSON in `E_SCHEMA_PARSE` (was a raw `SyntaxError`) and verifies HMAC signatures with a timing-safe comparison.
- Level-B/Level-C log loaders wrap malformed JSONL lines in `E_SCHEMA_PARSE` with file path and line number.
- `verifyTape` rejects empty tapes and tapes that do not start with a header record.
- `pi-harness replay` parses the tape once instead of twice (new `verifyTapeRecords` helper).
- `npm run lint` now has a repo-local TypeScript ESLint config instead of failing with missing-config / unmatched-pattern errors.
- `npm test` no longer runs the hash-chain microbench by default; the perf bench moved to opt-in `npm run bench`.

### Performance
- Bridge event ids come from a per-run counter instead of filtering or indexOf-scanning the whole event array per emit/broadcast, which made event emission O(n^2) over a run's lifetime.
- The bridge client backs off run polling from 50ms to a 500ms ceiling instead of hammering `/runs` at ~20 req/s for the whole run.
- `compactHistory` indexes compactable segments by event index (Map lookup) instead of a per-event linear scan.
- The query loop builds sofie tool evidence from two lookup maps instead of scanning the full event and effect arrays per policy decision.
- `read_events` finds the last event for an execution with a reverse index walk instead of copying and reversing the whole session event array on every wake-up.

### Changed
- Hash-chain bench ceilings are now explicitly env-configurable via `PI_HASHCHAIN_BENCH_CEILING_MS`, with defaults widened to `12ms` local / `16ms` CI for slower storage/runner variance.

## [0.70.2] — 2026-04-25

### Added
- Acceptance helpers: `pi-harness acceptance-hermes` and `pi-harness acceptance-pi`.
- `kb` CLI entrypoint with `kb session acceptance hermes` and `kb session acceptance pi`.
- Hermes acceptance helper can now run in self-contained embedded mode without a pre-started bridge, token file, or KB server.
- Saved acceptance runbooks under `wiki/personal/agent-bootstrap/` for Hermes and Pi.

### Changed
- Version bump to `0.70.2`.

## [0.4.0] — 2026-04-18

Maintenance + perf release. Toolchain aligned with `@mariozechner/pi-coding-agent` v0.67.68. 55 test files, 166 tests, tsc clean, zero audit findings.

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
- **`doctor` CLI coverage** — `tests/unit/doctor.test.ts` (2 tests) asserts every check returns a `{ name, ok, detail? }` shape and that a healthy repo reports all-green.
- **Append-mode invariant tests** — `tests/unit/replayRecorderAppendMode.test.ts` (5 tests) prevent any regression back to the old O(N²) rewrite writer: file size must grow monotonically across `writeEvent`s, each append stays verifiable as the chain extends, `writeEvent` after `close` throws, `close` is idempotent, and a second `writeHeader` cleanly replaces the tape.
- `ReplayRecorder#close()` — explicit close for the append file handle. Called by the CLI in a `finally` block so crashes during a run don't leak the handle.

### Fixed
- Eliminated a file-handle leak path: writers that re-used a `ReplayRecorder` across headers now close the prior handle before opening the new one.
- **Latent bug in `writeHeader` re-init:** calling `writeHeader` a second time on the same recorder used to chain off the prior session's final `recordHash` even though the on-disk file was rewritten from scratch. `prevHash` is now reset to the all-zero root on every `writeHeader`, so a re-initialized tape always roots correctly. Surfaced by the new append-mode invariant tests.

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
