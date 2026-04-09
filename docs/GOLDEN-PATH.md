# The Golden Path

One canonical scenario drives the Tier A implementation and proof.

## Scenario

A user runs the harness against a tiny TypeScript workspace containing a failing test:

```bash
pi-harness run ./.pi-work ./.pi-out
```

The Tier A loop then performs exactly this sequence:

1. Creates a session id.
2. Writes the session provenance manifest.
3. Seeds `./.pi-work/tests/math.test.ts` with the failing assertion `expect(1 + 1).toBe(3)`.
4. Starts the deterministic mock-model stream.
5. Emits `message_start`.
6. Emits a `text_delta` announcing that it is reading the failing test.
7. Calls `read_file` on `tests/math.test.ts`.
8. Wraps the read result as untrusted tool output.
9. Emits another `text_delta` announcing the patch step.
10. Calls `write_file` with the corrected assertion `expect(1 + 1).toBe(2)`.
11. Records one placeholder `PolicyDecision` for `read_file` and one for `write_file`.
12. Records one `EffectRecord` for the write.
13. Emits `message_stop` with `stopReason: "end_turn"`.
14. Writes the crash-safe checkpoint.
15. Leaves replayable artifacts on disk.

## Expected artifacts

For a session id `<sessionId>`, the run produces:

```text
.pi-out/
  tapes/<sessionId>.jsonl
  effects/<sessionId>.jsonl
  sessions/<sessionId>/
    checkpoint.json
    metrics.json
    policy.jsonl
    provenance.json
```

The repo also ships one committed canonical artifact set:

```text
goldens/canonical/
  tape.jsonl
  effects.jsonl
  policy.jsonl
```

## Expected tape shape

The canonical tape contains:

1. one header record
2. `message_start`
3. `text_delta`
4. `tool_use` for `read_file`
5. `tool_result` for `read_file`
6. `text_delta`
7. `tool_use` for `write_file`
8. `tool_result` for `write_file`
9. `message_stop`

## User verification flow

After a run, a user should be able to do all of the following:

```bash
pi-harness verify ./.pi-out/tapes/<sessionId>.jsonl
pi-harness what-changed ./.pi-out/effects/<sessionId>.jsonl
pi-harness inspect ./.pi-out/sessions/<sessionId>/policy.jsonl
pi-harness replay ./.pi-out/tapes/<sessionId>.jsonl
```

## Trace option

For lightweight loop debugging, the same run can emit a JSONL trace:

```bash
pi-harness run ./.pi-work ./.pi-out --trace
```

or

```bash
pi-harness run ./.pi-work ./.pi-out --trace=./trace.jsonl
```

This trace is supplemental only. The tape remains the authoritative replay artifact.

## CI proof

CI proves the canonical path by:

1. verifying the committed golden tape
2. replaying the committed golden tape
3. running the canonical golden path once
4. comparing the produced tape against the committed golden tape at **Level A**
5. comparing the produced effect log against the committed golden effect log at **Level B**
6. comparing the produced policy log against the committed golden policy log at **Level C**

## Out of scope

This golden path intentionally excludes:
- real provider integration
- hooks
- compaction
- concurrency
- worktrees / subagents
- rollback
- policy engine expansion beyond placeholder approvals
- multiple scenarios
