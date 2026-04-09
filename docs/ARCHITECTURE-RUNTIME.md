# Runtime Architecture

Five layers plus a cross-cutting observability/provenance layer. Each layer has a single responsibility and a narrow interface to the next. The loop never reaches past its immediate neighbor.

```
┌─────────────────────────────────────────────────────────────┐
│ 5. Session & Provenance  (ProvenanceManifest, Checkpoint)   │
├─────────────────────────────────────────────────────────────┤
│ 4. Loop                  (runQueryLoop, retry, compaction)  │
├─────────────────────────────────────────────────────────────┤
│ 3. Tool Dispatch         (ConcurrencyClassifier, schedule)  │
├─────────────────────────────────────────────────────────────┤
│ 2. Policy & Hooks        (PolicyEngine, HookDispatcher)     │
├─────────────────────────────────────────────────────────────┤
│ 1. Adapter               (PiAdapterClient, ModelClient)     │
├─────────────────────────────────────────────────────────────┤
│ +. Integrity & Audit     (ReplayRecorder, EffectRecorder,   │
│                           Counters, SanitizationRecord)     │
└─────────────────────────────────────────────────────────────┘
```

## Layer 1 — Adapter (`src/adapter/`)

Converts provider-specific streaming shapes into our `StreamEvent` discriminated union. The `PiAdapterClient` consumes a `PiProviderLike` (pi.dev, or a mock, or a recorded cassette) and emits typed events. Nothing above this layer sees a raw SSE chunk or an Anthropic-shaped message.

**Invariant.** Every non-`StreamEvent` shape dies at this boundary. `E_MODEL_ADAPTER` is thrown for malformed chunks.

## Layer 2 — Policy & Hooks (`src/policy/`, `src/hooks/`)

Given a tool_use event, `PolicyEngine.decide()` produces a `PolicyDecision` with full provenance (matched rules, winning rule, evaluation order, mode/manifest/hook influences). `HookDispatcher` routes lifecycle events (`PreToolUse`, `PostToolUse`, `SessionStart`, etc.) to in-process hooks; shell/HTTP hooks are contract-only at this layer (see `HOOK-SECURITY.md`).

**Invariant.** A decision is always recorded before the tool runs. A deny decision short-circuits into a tool-error `StreamEvent` without touching Layer 3.

## Layer 3 — Tool Dispatch (`src/tools/`)

`ConcurrencyClassifier` tags every tool name as `readonly | serial | exclusive`. Milestone 5 keeps this deliberately small and deterministic:
- `readonly` tools may run in parallel with other readonly tools in the same ready batch
- `serial` tools run one-at-a-time in original event order
- `exclusive` tools run alone and block surrounding work

The scheduler is library-first and runtime-only. It derives an execution plan from already-approved tool calls, preserves original event order for visible result collation, and does not persist queue or in-flight state.

**Invariant.** No serial tool overlaps any other serial or exclusive tool. No exclusive tool overlaps anything else. Readonly tools may overlap only with other readonly tools, and their visible `tool_result` collation remains in original event order.

## Layer 4 — Loop (`src/loop/`)

`runQueryLoop` orchestrates the Tier A + early Tier B pipeline. It:

1. Opens the model stream and consumes `StreamEvent`s sequentially.
2. Optionally applies a bounded deterministic retry wrapper only around model invocation / first-pull failures before any event from that invocation has been durably written to tape.
3. Records each event to the replay tape before any downstream handling.
4. For `tool_use`, computes the base policy decision first, then applies Milestone 2 pre-hook mediation if hooks are configured.
5. Buffers adjacent approved `tool_use` events into a deterministic batch, then schedules them with the Milestone 5 classifier if concurrency is configured.
6. For each allowed tool, pre-snapshots paths when needed, runs the tool once, captures an `EffectRecord` for mutating tools, runs observe-only post-hooks, wraps output via `wrapToolOutput`, and emits a `tool_result` event in original event order.
7. Optionally derives a deterministic compacted runtime view from the recorded event history when `compactTargetBytes` is supplied and the emitted history exceeds that threshold.
8. Writes the loop-end checkpoint via `safeWriteJson`.

Retry rules in the current release line:
- disabled unless explicit `retry` config is supplied
- retryable only for transient model-open failures classified from normalized `code` / `name` / `status`
- no jitter; capped deterministic backoff only
- once one event from the current model invocation is durably written, retry is no longer allowed for that invocation
- tool execution, policy decisions, hook decisions, schema/parse failures, and persistence failures remain fail-closed / non-retryable in this milestone

Scheduling rules in the current release line:
- disabled unless a `ConcurrencyClassifier` is explicitly supplied
- classification is explicit and minimal: `readonly | serial | exclusive`
- readonly tools may execute in parallel only within the deterministic scheduler batch
- serial and exclusive tools are never parallelized with mutating work
- scheduler state (queues, in-flight work, plan groups) is runtime-only

Compaction rules in the current release line:
- disabled unless `compactTargetBytes` is explicitly supplied
- tape history remains the source of truth
- compaction rewrites only the runtime `compactedEvents` view, never the historical `events` list or the tape
- the first and only strategy in Milestone 4 is deterministic tool-result body compaction
- policy logs, effect logs, provenance, checkpoint shape, and canonical goldens are unaffected

**Invariant.** The loop never writes to the filesystem except via Layer + recorders and `safeWriteJson`. Successful retries before the first persisted event are invisible in tape shape; once an event is written, the invocation is committed and will not be retried. Scheduling may change execution timing of allowed tools, but visible result collation stays deterministic and tape truth remains authoritative. Compaction may change the runtime context view, but it never mutates historical tape truth.

## Layer 5 — Session & Provenance (`src/session/`)

Opens the session directory, writes the `ProvenanceManifest` (loopGitSha, repoGitSha, provider, model, costTableVersion, piMdDigest, policyDigest) via `safeWriteJson` (write-rename + fsync), and holds the `Checkpoint` for crash recovery.

**Invariant.** The manifest is written once at session start and is the single place a reviewer looks to answer "what code, what model, what policy produced this tape?"

## Cross-cutting — Integrity & Audit (`src/replay/`, `src/effect/`, `src/metrics/`)

- **`ReplayRecorder`** — append-only hash-chained tape (`ADR 0002`). Every `StreamEvent` goes through it.
- **`EffectRecorder`** — pre-snapshot + post-capture for every mutating tool, emitting `EffectRecord`s with unified diffs and rollback confidence.
- **`SanitizationRecord`** — per-tool-output wrapper rewrites (ANSI, nested tags, control chars, truncation).
- **`Counters`** — in-memory observability (OTel swap is Tier C).

These are called by Layer 4 but written to by no other layer. They are the only things a post-hoc auditor needs to reconstruct a session.

## Data flow (one turn)

```
model.stream() ──► [optional retry only before first persisted event]
        │
        ▼
   StreamEvent ──► tape
        │
        ├── non-tool event ──► continue
        │
        └── tool_use ──► PolicyEngine.decide ──► Hook mediation (PreToolUse)
                               │
                       deny? ──► tool-error event ──► tape
                               │
                               ▼
                     deterministic scheduler batch (optional)
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
      readonly group (parallel)          serial / exclusive (one-at-a-time)
              │                                 │
              └────────────────┬────────────────┘
                               ▼
                        EffectRecorder.pre ──► tool(input)
                               │                    │
                               │                    ▼
                               │            Hook mediation (PostToolUse, observe-only)
                               ▼
                        EffectRecorder.post ──► EffectRecord
                               │
                               ▼
                      wrapToolOutput ──► tool_result ──► tape
                                                       │
                                                       ▼
                                  compactedEvents runtime view (optional, derived)
```

## What's not in the runtime (by design)

- **MCP host.** Tier C.
- **Multi-provider fanout.** Tier C; the adapter seam is ready.
- **OpenTelemetry.** Tier C; `Counters` is the swap point.
- **Permission prompts UI.** Out of scope — the loop emits `ask` decisions and leaves UI to the caller.
