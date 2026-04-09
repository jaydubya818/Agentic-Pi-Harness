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

`ConcurrencyClassifier` tags every tool name as `readonly | serial | exclusive`. `schedule()` consumes a batch of approved tool calls and dispatches them honoring the class: readonly in parallel, serial queued per-name, exclusive drains. Adjacent `tool_use` events in the stream are buffered into a batch by the loop so the scheduler can make batch-level decisions.

**Invariant.** No two exclusive tools overlap. No serial tool of the same name overlaps itself. Readonly tools may overlap freely.

## Layer 4 — Loop (`src/loop/`)

`runQueryLoop` orchestrates the Tier A + early Tier B pipeline. It:

1. Opens the model stream and consumes `StreamEvent`s sequentially.
2. Optionally applies a bounded deterministic retry wrapper only around model invocation / first-pull failures before any event from that invocation has been durably written to tape.
3. Records each event to the replay tape before any downstream handling.
4. For `tool_use`, computes the base policy decision first, then applies Milestone 2 pre-hook mediation if hooks are configured.
5. If approved, pre-snapshots paths, runs the tool once, captures an `EffectRecord` for mutating tools, runs observe-only post-hooks, wraps output via `wrapToolOutput`, and emits a `tool_result` event.
6. Writes the loop-end checkpoint via `safeWriteJson`.

Retry rules in the current release line:
- disabled unless explicit `retry` config is supplied
- retryable only for transient model-open failures classified from normalized `code` / `name` / `status`
- no jitter; capped deterministic backoff only
- once one event from the current model invocation is durably written, retry is no longer allowed for that invocation
- tool execution, policy decisions, hook decisions, schema/parse failures, and persistence failures remain fail-closed / non-retryable in this milestone

**Invariant.** The loop never writes to the filesystem except via Layer + recorders and `safeWriteJson`. Successful retries before the first persisted event are invisible in tape shape; once an event is written, the invocation is committed and will not be retried.

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
                        EffectRecorder.pre ──► tool(input)
                               │                    │
                               │                    ▼
                               │            Hook mediation (PostToolUse, observe-only)
                               ▼
                        EffectRecorder.post ──► EffectRecord
                               │
                               ▼
                      wrapToolOutput ──► tool_result ──► tape
```

## What's not in the runtime (by design)

- **MCP host.** Tier C.
- **Multi-provider fanout.** Tier C; the adapter seam is ready.
- **OpenTelemetry.** Tier C; `Counters` is the swap point.
- **Permission prompts UI.** Out of scope — the loop emits `ask` decisions and leaves UI to the caller.
