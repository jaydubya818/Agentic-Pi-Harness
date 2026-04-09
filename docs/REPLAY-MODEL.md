# Replay Model

## Three layers of determinism

### Level A — Event determinism
The normalized `StreamEvent` stream matches byte-for-byte between a live run and a replay, **except** these explicitly tolerated fields:

- `timestamp`, `wallClockMs`
- `traceId`, `spanId`
- Provider-opaque IDs passed through from upstream
- Random IDs NOT derived from a deterministic hash
- Any field tagged `@nondeterministic` in its Zod schema

Replay-drift CI diffs at this level on every PR.

### Level B — Effect determinism
The effect log matches:
- `paths` (sorted)
- `preHashes`, `postHashes`
- `unifiedDiff` (canonicalized: hunks sorted by start line, no trailing whitespace, `\n` line endings)
- `binaryChanged` flag

Explicitly excluded: file `mtime`, `atime`, `ctime`; `rollbackRef` paths; any wall-clock in the record.

### Level C — Decision determinism
The stream of `PolicyDecision`, hook-mediated deny outcomes, and tool-routing choices matches.

Milestone 3 retry semantics do **not** introduce a new persisted retry artifact or replay tape event type. Successful retries before the first persisted event of a model invocation are intentionally invisible in tape shape; failed retries leave the tape valid up to the last durable record.

Milestone 4 compaction semantics do **not** mutate tape truth. Compaction only derives a reduced runtime view (`compactedEvents`) from the already-recorded event history. Replay continues to read the authoritative tape / `events` history, not the compacted runtime view.

Milestone 5 scheduling semantics also leave tape truth intact. Scheduling changes only how already-approved tool executions are dispatched at runtime; visible `tool_result` collation remains deterministic and replay continues to read the authoritative tape.

Milestone 6/7/8 add subagent coordination, supervised approvals, and stronger worker controls as runtime layers around execution. They do not introduce a new tape event type or mutate historical tape truth. Where they affect persisted decisions, they do so only through already-existing extensible fields and the existing `PolicyDecision` record shape.

Placeholder decisions (`provenanceMode: "placeholder"`) are tolerated against full decisions during Phase 1–2; after Phase 3 this becomes a hard diff.

## Migration posture

- Default replay pins to the tape header's `loopGitSha`. Replaying against current code requires `--compat` with an explicit, tested migrator at `src/schemas/migrations/vN-to-vN+1.ts`.
- Migrate **if and only if** a tested migrator exists. Otherwise: fail closed with a pointer to the migration gap.

## Header

Every tape begins with:
```json
{
  "type": "header",
  "schemaVersion": 1,
  "sessionId": "...",
  "createdAt": "...",
  "loopGitSha": "...",
  "policyDigest": "sha256:...",
  "costTableVersion": "2026-04-01",
  "prevHash": "0000...",
  "recordHash": "sha256:..."
}
```

## Retry compatibility

Milestone 3 keeps retry state runtime-only:
- no new artifact family
- no new tape event type
- no retry metadata persisted into `PolicyDecision`, `EffectRecord`, checkpoint, or provenance

Retryable scope in this release line is intentionally narrow:
- only transient model-open failures before the first event of the current invocation is durably written
- deterministic capped backoff only
- no tool retries
- no mid-stream resumption after persisted output

That means replay stays compatible with the existing tape/effect/policy contracts: a successful retried invocation produces the same persisted sequence as a first-try success.

## Compaction + scheduling + supervision compatibility

Milestone 4–8 keep compaction, scheduling, approvals, subagent coordination, and worker controls compatible with existing replay and inspection surfaces:
- no new persisted artifact family
- no new replay tape event type
- no mutation of historical tape records after emit
- no persistence of scheduler queue / lane / in-flight state
- no persistence of approval pending-state packets
- no persistence of subagent in-flight coordination state
- no compaction of policy logs, effect logs, provenance, or canonical goldens

The compacted runtime view is deterministic from the event history plus `compactTargetBytes`. Same history + same threshold => same compacted result.

The scheduler plan is deterministic from approved tool-use event order plus explicit classification. Same event history + same classifier => same visible tool-result ordering.

Approval mediation is deterministic from the `ask` decision plus the runtime approval outcome. Worker controls are deterministic from mode + explicit controls + tool input.

## Replay debugger / operator UX

Milestone 10 adds library-only replay debugger helpers that derive merged timelines from the existing tape, policy log, and effect log. This is intentionally additive operator UX on top of existing persisted artifacts; it does not change the artifact contracts themselves.

## Hash chain

Each record includes `prevHash = sha256(prev.recordHash)`. Tape digest = last record's `recordHash`. `pi-harness verify` walks the chain in one pass with schema validation.

**Overhead budget**: ≤2ms p99 per record, ≤2% session wall-clock overhead. If exceeded, switch to chunked chaining (16 records per node) via `PI_HASH_CHUNK_SIZE`.
