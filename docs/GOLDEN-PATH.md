# The Golden Path

One canonical scenario drives Phase 1–2 implementation order. Every task is prioritized by whether it advances this path.

## The scenario

> A user has a failing test in a small TypeScript project. They launch `pi-harness run --mode assist "fix the failing test in tests/math.test.ts"`. The harness:
>
> 1. Loads `PI.md` from the project, computes policy digest, writes the session **provenance manifest**.
> 2. Starts the **query loop** and streams a mock model response that calls `read_file("tests/math.test.ts")`.
> 3. The loop dispatches the read via the **streaming executor** (Tier B concurrency classes; in v0.1 Phase 1 all tools run serially).
> 4. The `read_file` tool emits a **`ToolAuditRecord`**; output is wrapped in `<tool_output trusted="false" tool="read_file" id="...">` per the prompt-assembly rule.
> 5. Mock model responds with a `write_file("tests/math.test.ts", <patched content>)` tool call.
> 6. The loop writes a **placeholder `PolicyDecision`** (`provenanceMode: "placeholder"`, `result: "approve"`).
> 7. The **effect recorder** snapshots the pre-hashes of `tests/math.test.ts`, then the tool runs, then the effect recorder captures post-hashes + unified diff → writes one `EffectRecord`.
> 8. The mock model emits `message_stop` with `stopReason: "end_turn"`.
> 9. The loop writes a **checkpoint** (crash-safe: write-rename + fsync) and closes the session.
> 10. The **replay recorder** closes the tape with a header containing `loopGitSha`, `policyDigest`, `costTableVersion`, hash-chain digest.
> 11. User runs `pi-harness verify <tape>` → green (schema + chain).
> 12. User runs `pi-harness what-changed <sessionId>` → shows the unified diff of `tests/math.test.ts`.
> 13. User runs `pi-harness inspect --policy <sessionId>` → shows one placeholder decision with `provenanceMode: "placeholder"`.
> 14. CI replays the same tape against the loop → byte-equal event stream at Level A + matching effect log at Level B + matching decision stream at Level C.

## Why this scenario

It exercises every Tier A-runtime component end-to-end:
- Session start + provenance manifest
- Zod schema validation
- Loop 5-phase execution
- Mock `ModelClient` adapter
- Tool dispatch + audit records
- Prompt-injection containment wrapping
- Placeholder policy decisions
- Effect recorder (minimum spec)
- Crash-safe checkpoint writes
- Replay tape with hash chain + header
- `verify`, `what-changed`, `inspect` CLIs
- Replay-drift CI at all three determinism levels

It **does not** exercise (intentionally deferred):
- Multiple providers
- Real retries (mock doesn't fail)
- Compaction
- Permissions engine (placeholder only)
- Sub-agents / worktrees
- Hooks
- Worker mode
- Signed policy

## Gate

By **end of Week 2**, running the golden path must produce:
1. A session directory under `~/.pi/sessions/<id>/` with `provenance.json`, `checkpoint.json`, `metrics.json`.
2. A tape at `~/.pi/tapes/<id>.jsonl` that passes `pi-harness verify`.
3. An effect log at `~/.pi/effects/<id>.jsonl` with one record.
4. `pi-harness what-changed <id>` output matching the expected diff.
5. `pi-harness replay <tape>` producing byte-equal events at Level A.

If this does not work by Friday of Week 2, feature work halts until it does.
