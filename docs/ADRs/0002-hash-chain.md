# ADR 0002 — Hash-Chained Replay Tape

**Status:** accepted — 2026-04-08
**Deciders:** jay
**Supersedes:** —

## Context

The replay tape is the source of truth for "what did the model see and emit." Any post-hoc tampering — a reviewer silently editing a `text_delta`, an attacker removing a denied tool call, a partial write during a crash — has to be detectable. A flat JSONL file is not enough; we need a per-record integrity seal that also captures ordering.

## Decision

Every tape record carries `prevHash` and `recordHash`. `prevHash` is the previous record's `recordHash` (or 64 zeros for the header). `recordHash` is `"sha256:" + sha256Hex(canonicalize(rest))`, where `rest` is the record with `recordHash` omitted. Canonicalization is the framed procedure from `docs/SCHEMAS.md` — sorted keys, no whitespace, no `undefined`/`NaN`, framed `pi-tape-v1\n` prefix at the digest level for the header.

`verifyTape()` walks the file, recomputes each `recordHash`, and compares both the chain (`rec.prevHash === runningPrev`) and the seal (`rec.recordHash === expected`). A single flipped byte, a swapped pair of records, a truncated final line, or an appended bogus record all fail the check.

**Overhead budget:** ≤2ms p99 per append and ≤2% of session cost, measured via `Counters`. If a tape produces more than 16 records per second sustained, the recorder falls back to chunked mode: hash N records as a batch with a single `chunkHash`, check-pointing every 16.

## Consequences

- **Positive.** Integrity of every stored event; any mutation anywhere in the file fails verification. Third-party auditors can re-verify with only the recorder code and the file.
- **Positive.** `verifyTape()` doubles as a CI gate for replay drift — CI records a tape and verifies it before merge.
- **Positive.** The chain doubles as ordering: reordering any two records breaks `prevHash` without needing a separate sequence check.
- **Negative.** ~2ms per append. Chunked fallback costs observability resolution for throughput. Acceptable for the expected record rates (typically <5/s).
- **Negative.** Changing canonicalization or the frame string is a breaking format change. Covered by `schemaVersion` on the header and a migrator requirement from `docs/SCHEMAS.md`.

## Alternatives considered

1. **Merkle tree over the whole file.** Stronger (log-random access) but adds complexity and requires a sidecar index. Overkill for append-only streaming.
2. **GPG-signed tape.** Works but conflates identity with integrity; shifts the trust model. Signing is orthogonal and can be layered on top of the hash chain later.
3. **No integrity, rely on filesystem.** Rejected — an attacker with write access to the tape file can silently edit history, and a crash mid-append would be indistinguishable from a legitimate write.

## Tests

- `tests/unit/verify.test.ts` — round-trip + single-byte tamper
- `tests/chaos/tapeCorruption.test.ts` — truncated tail, reordered records, injected record
- Overhead instrumentation is a Tier B follow-up; the p99 budget is enforced via a microbench in `tests/bench/` (not yet landed).
