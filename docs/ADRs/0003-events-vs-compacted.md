# ADR 0003 — `LoopResult.events` vs `LoopResult.compactedEvents`

Status: accepted — 2026-04-08
Context: Tier B loop (`src/loop/query.ts`)

## Problem

The loop has two readers with conflicting requirements:

1. **The replay tape + verifier.** Needs the *faithful* list of everything
   emitted this turn, byte-for-byte matching what was appended to the
   hash-chained tape. Any mutation after the fact breaks the chain.
2. **The next model turn's prompt assembler.** Needs a *compacted* view that
   fits the model's context budget — tool outputs dropped, old text deltas
   summarised, early turns pruned.

A previous version of the loop compacted in place, mutating `events` after
the tape was already written. The in-memory record then disagreed with the
tape: `events.length` could shrink, a `tool_result` dropped in memory was
still on disk, and verification still passed (tape was untouched) but any
caller that believed `events` was the tape record was now wrong.

## Decision

`runQueryLoop` returns both:

```ts
interface LoopResult {
  events: StreamEvent[];          // faithful tape record — never mutated post-emit
  compactedEvents: StreamEvent[]; // view for the next turn's prompt — may alias `events`
  // ...
}
```

Rules:

- `events` is append-only inside the loop and frozen on return. The tape
  writer and the in-memory list are updated in the same `emit()` call.
- `compactedEvents` starts as `events` (identity alias, zero copy) and is
  replaced with a new array only if `compact()` ran. `compact()` is pure —
  it reads `events` and returns a fresh array plus a `CompactionRecord`.
- The next turn's prompt assembly MUST read `compactedEvents`.
- The verifier, `what-changed`, `replay`, and any audit consumer MUST read
  `events` (or re-read the tape from disk).

## Consequences

Pro:
- Tape and in-memory record can never diverge.
- Compaction is a pure function, trivially testable and cacheable.
- Zero-copy when nothing was compacted.

Con:
- Two fields where callers used to see one — slight API surface cost.
- Callers must know which list to read. Mitigated by the field names and
  the TSDoc on `LoopResult`.

## Alternatives rejected

- **Mutate in place, re-emit compacted records to the tape.** Would double-
  write the tape and break the hash chain (records would have the same
  `seq` as already-committed ones).
- **Compact only in the prompt assembler, leave the loop untouched.** Pushes
  the same problem one layer up and forces every caller that wants a
  compacted view to re-implement it. Also loses the `CompactionRecord`
  audit trail.
- **Return only `compactedEvents` and re-read the tape for `events`.** Adds
  a filesystem round trip to every caller that wants to inspect the turn,
  and couples callers to the tape path.
