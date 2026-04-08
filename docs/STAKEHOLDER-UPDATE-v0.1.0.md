# v0.1.0 shipped — Agentic Pi Harness

**Date:** 2026-04-08
**Audience:** Anyone using or evaluating the harness
**Status:** GA (tagged `v0.1.0`, CI green)

## Headline

First tagged release of Agentic-Pi-Harness is live:
https://github.com/jaydubya818/Agentic-Pi-Harness/releases/tag/v0.1.0

Tier A (runtime foundation) and Tier B (supervised runtime) are both GA.
Three CI jobs — test, golden-path, replay-drift — all green. 22 test files,
59 tests, tsc clean, zero runtime deps besides `zod`.

## What this gives you

A Claude-Code-grade agent runtime built on top of pi.dev. The short
version:

- **Deterministic replay.** Every turn is written to a hash-chained tape.
  Two independent runs of the golden path produce byte-identical effect
  logs. CI verifies this on every commit.
- **Signed policy with full provenance.** Rules match on tool, mode, path,
  and input content. Every decision records what matched, what won, and
  why. Worker mode refuses unsigned policy.
- **Isolated sub-agents.** Each sub-agent runs in its own git worktree
  with an escape guard. Main repo cannot be touched until merge.
- **Prompt-injection containment.** All tool output is wrapped as
  `<tool_output trusted="false">` with ANSI, nested-tag, and control-char
  stripping. Fuzz-tested at 200 iterations.
- **Crash-safe writes** (write-rename + fsync) for checkpoint, tape,
  effect log, policy log, provenance.
- **Retry state machine** that distinguishes transient, rate-limit,
  context-overflow, and fatal — context overflow bubbles as
  `E_BUDGET_EXCEEDED` instead of retrying silently.
- **Per-hook timeouts** on the in-process hook dispatcher. One slow hook
  cannot stall the loop.

## What's not in v0.1.0 (deferred to v0.2.0+)

See `docs/ROADMAP.md` and `docs/ADRs/0004-tier-c-scope.md`.

- OpenTelemetry metrics export — counters are in-memory today
- Semantic decision-log equivalence (Level-C drift currently matches by
  rule id, not effect class)
- Windows support — POSIX-only at the filesystem layer
- Real pi.dev provider integration — the seam exists, the golden path
  uses a `MockModelClient`
- Shell-contract hook executor — documented, not wired

## How to try it

```bash
git clone https://github.com/jaydubya818/Agentic-Pi-Harness
cd Agentic-Pi-Harness
npm install
npx tsx src/cli/doctor.ts
npx tsx src/cli/run.ts ./.pi-work ./.pi-out
npx tsx src/cli/verify.ts $(ls ./.pi-out/tapes/*.jsonl | head -1)
npx tsx src/cli/replay.ts $(ls ./.pi-out/tapes/*.jsonl | head -1)
```

The `doctor` command runs basic environment checks. `run` executes the
golden path against a mock model. `verify` walks the hash chain. `replay`
pretty-prints the tape.

## What to look at first

- `src/loop/query.ts` — the 5-phase iteration with per-chunk retry
- `src/policy/engine.ts` — rule-based permission with full provenance
- `src/effect/recorder.ts` — per-call `EffectScope` (this is the concurrency fix)
- `docs/ADRs/` — the four decisions worth reading before you extend anything

## Feedback wanted

Most valuable feedback at this stage:

1. Does the CLI surface feel usable? `doctor` / `run` / `verify` / `replay`
   / `what-changed` / `inspect` — or should some of these be subcommands?
2. Are the ADRs readable? They're the canonical "why it's built this way"
   source.
3. What's missing from the Tier C roadmap (ADR 0004)? If something in
   your workflow is blocked on a v0.2.0 feature, tell me so I can
   prioritize.

## Credits

Built on top of Mario Zechner's [pi](https://github.com/mariozechner/pi).
The adapter seam (`src/adapter/piDevProvider.ts`) is the only place we
touch pi's internals — everything else sits on top.
