# Agentic Pi Harness

A Claude-Code-grade agent runtime built on top of the [pi.dev](https://github.com/mariozechner/pi) TS harness. Deterministic replay, hash-chained tapes, prompt-injection containment, effect recording, crash-safe checkpoints.

**Status:** v0.1.0-rc — Tier A + Tier B shipped. 18 test files / 50 tests, tsc clean. See [`docs/GOLDEN-PATH.md`](docs/GOLDEN-PATH.md) for the canonical end-to-end scenario and [`docs/ADRs/0001-scope-tiering.md`](docs/ADRs/0001-scope-tiering.md) for scope gating.

## Quick start

```bash
npm install
npm run build
node dist/cli/index.js doctor
node dist/cli/index.js run ./.pi-work ./.pi-out
node dist/cli/index.js verify ./.pi-out/tapes/<sessionId>.jsonl
node dist/cli/index.js what-changed ./.pi-out/effects/<sessionId>.jsonl
node dist/cli/index.js inspect ./.pi-out/sessions/<sessionId>/policy.jsonl
```

## What's in Tier A (shipped)

- Zod schemas with `schemaVersion` for every persisted type (`src/schemas/`)
- Async-generator query loop with placeholder policy engine (`src/loop/query.ts`)
- Mock model adapter for deterministic runs (`src/adapter/pi-adapter.ts`)
- Effect recorder (pre/post hash + unified diff + rollback confidence) (`src/effect/recorder.ts`)
- Replay recorder with hash chain + framed canonicalization (`src/replay/recorder.ts`)
- Prompt-injection containment (`<tool_output trusted="false">` wrapping + sanitization) (`src/loop/promptAssembly.ts`)
- Crash-safe writes (write-rename + fsync) (`src/session/provenance.ts`)
- CLIs: `doctor`, `run`, `verify`, `what-changed`, `inspect`

## What's in Tier B (shipped)

- `PolicyEngine` with full provenance (matched rules, winning rule, mode/manifest/hook influences) (`src/policy/engine.ts`)
- HMAC-SHA256 signed policy, strict worker-mode verification (`src/policy/signed.ts`)
- In-process hook dispatcher with per-hook timeouts and canonical audit digests (`src/hooks/dispatcher.ts`)
- Retry state machine with transient / rate_limit / context_overflow / fatal classification (`src/retry/stateMachine.ts`)
- 4-strategy compaction with `CompactionRecord` audit trail (`src/context/compaction.ts`)
- Concurrency classifier — readonly parallel, serial per-name, exclusive drain (`src/tools/concurrency.ts`)
- Sub-agent git worktree isolation with escape guard (`src/subagents/worktree.ts`)
- Level B (effects diff) and Level C (decisions diff) replay drift detection (`src/replay/levelB.ts`, `src/replay/levelC.ts`)
- Real pi.dev provider seam with lazy import and chunk normalization (`src/adapter/piDevProvider.ts`)

## Docs

- [GOLDEN-PATH.md](docs/GOLDEN-PATH.md) — the canonical scenario
- [EXECUTION-MODES.md](docs/EXECUTION-MODES.md) — plan / assist / autonomous / worker / dry-run
- [ARCHITECTURE-RUNTIME.md](docs/ARCHITECTURE-RUNTIME.md) — 5+1 layer diagram + invariants
- [REPLAY-MODEL.md](docs/REPLAY-MODEL.md) — three layers of determinism
- [PROMPT-ASSEMBLY.md](docs/PROMPT-ASSEMBLY.md) — prompt-injection containment
- [THREAT-MODEL.md](docs/THREAT-MODEL.md) — trust boundaries + attack vectors
- [HOOK-SECURITY.md](docs/HOOK-SECURITY.md) — in-process-first hook policy
- [SCHEMAS.md](docs/SCHEMAS.md) — versioning + canonicalization
- [ADRs/0001-scope-tiering.md](docs/ADRs/0001-scope-tiering.md) — Tier A/B/C decision
- [ADRs/0002-hash-chain.md](docs/ADRs/0002-hash-chain.md) — tape hash chain trade-offs
- [ADRs/0003-events-vs-compacted.md](docs/ADRs/0003-events-vs-compacted.md) — `LoopResult` split

## License

MIT — see [LICENSE](LICENSE).
