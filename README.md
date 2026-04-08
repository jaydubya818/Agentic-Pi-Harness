# Agentic Pi Harness

A Claude-Code-grade agent runtime built on top of the [pi.dev](https://github.com/mariozechner/pi) TS harness. Deterministic replay, hash-chained tapes, prompt-injection containment, effect recording, crash-safe checkpoints.

**Status:** v0.0.1 Tier A foundation. See [`docs/GOLDEN-PATH.md`](docs/GOLDEN-PATH.md) for the canonical end-to-end scenario and [`docs/ADRs/0001-scope-tiering.md`](docs/ADRs/0001-scope-tiering.md) for scope gating.

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

## What's Tier B (next)

Permission engine with full provenance, signed policy (HMAC), hook system (in-process + shell contract), sub-agent worktrees, compaction, retry state machine, Level B/C replay determinism, streaming concurrency classes.

## Docs

- [GOLDEN-PATH.md](docs/GOLDEN-PATH.md) — the canonical scenario
- [REPLAY-MODEL.md](docs/REPLAY-MODEL.md) — three layers of determinism
- [PROMPT-ASSEMBLY.md](docs/PROMPT-ASSEMBLY.md) — prompt-injection containment
- [THREAT-MODEL.md](docs/THREAT-MODEL.md) — trust boundaries + attack vectors
- [HOOK-SECURITY.md](docs/HOOK-SECURITY.md) — in-process-first hook policy
- [SCHEMAS.md](docs/SCHEMAS.md) — versioning + canonicalization
- [ADRs/0001-scope-tiering.md](docs/ADRs/0001-scope-tiering.md) — Tier A/B/C decision
