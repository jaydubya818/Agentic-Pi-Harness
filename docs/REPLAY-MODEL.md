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
The stream of `PolicyDecision`, `CompactionRecord`, retry events, approval outcomes, and tool-routing choices matches.

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

## Hash chain

Each record includes `prevHash = sha256(prev.recordHash)`. Tape digest = last record's `recordHash`. `pi-harness verify` walks the chain in one pass with schema validation.

**Overhead budget**: ≤2ms p99 per record, ≤2% session wall-clock overhead. If exceeded, switch to chunked chaining (16 records per node) via `PI_HASH_CHUNK_SIZE`.
