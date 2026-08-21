# Harness invariants

An audit of this repo against the five invariants in the KB pattern
`patterns/pattern-code-owns-control-plane` ("agent proposes, code disposes"),
plus two claims from `syntheses/harness-vs-meta-harness-vs-self-improving-harness`
and `syntheses/synthesis-telephone-game-per-claim-confidence`.

This file exists so a later pass can diff against it instead of re-deriving the
audit. Each line cites the file and function it was checked against. Statuses
are **satisfied**, **partial**, **violated**, or **deliberate divergence**.

Audited 2026-08-21 against `nightly/2026-08-21-improvements`.

---

## Invariant 1 — deterministic code owns the graph

**Status: satisfied.**

`runQueryLoop` (`src/loop/query.ts`) owns sequencing end to end. The model is
an `AsyncIterable<StreamEvent>` and nothing more: it emits events, and the loop
alone decides what happens to each one. Concretely, code — not the agent —
decides:

- **what runs next**: `flushPendingToolUses` batches pending `tool_use` events
  and hands them to `scheduleCalls` (`src/tools/concurrency.ts`); the agent has
  no say in ordering or parallelism.
- **whether a call runs at all**: `prepareToolDispatch` calls `decidePolicy`
  (`src/policy/decision.ts`) and `evaluateWorkerToolUse`
  (`src/runtime/workerControls.ts`) before dispatch, and can substitute
  `deniedToolResult` / `unknownToolResult` without invoking the tool.
- **how retries happen**: `src/retry/stateMachine.ts` is a pure classifier
  (`classifyRetryableModelError`, `shouldRetryModelInvocation`,
  `computeRetryDelayMs`). Retry is a function of the error and the attempt
  count, never of anything the model says.

## Invariant 2 — agents are bounded nodes inside named phases

**Status: satisfied.**

The model client is reached only through the `ModelClient` interface
(`src/adapter/pi-adapter.ts`) and is normalised at the seam by
`PiAdapterClient.convert` (`src/adapter/pi-client.ts`), which rejects any chunk
that does not fit the `StreamEvent` union with `E_MODEL_ADAPTER`. Provider
shapes do not leak past the adapter.

Phases are named by mode — `plan | assist | autonomous | worker | dry-run`
(`LoopMode`) — and `validateWorkerModeInputs` refuses to start a worker-mode run
without the controls that bound it. The agent cannot change its own mode
mid-run: `mode` is read once from `LoopInputs` and never rewritten.

## Invariant 3 — typed JSON envelopes are the only cross-boundary channel

**Status: partial** — satisfied for every harness-internal boundary, and
structurally unsatisfiable for the model boundary.

Satisfied everywhere the harness talks to itself. Every persisted artifact is a
versioned zod schema under `src/schemas/`: `TapeRecord`, `EffectRecord`,
`PolicyDecision`, `ProvenanceManifest`, `Checkpoint`, `SessionContext`,
`ToolAuditRecord`, `MetricsSnapshot`, `SanitizationRecord`. Each carries a
`schemaVersion` literal, and reads go through `parseOrThrow`
(`src/schemas/parse.ts`) rather than a bare cast. `verifyTapeRecords`
(`src/replay/recorder.ts`) additionally enforces structural invariants the type
system cannot — header-first, monotonic `seq`, unbroken hash chain — so a
re-numbered or spliced tape fails verification rather than reading as `ok`.

Not satisfiable at the model boundary, and worth stating plainly rather than
scoring as a pass. Tool output crosses into the model as a **string**:
`wrapToolOutput` (`src/loop/promptAssembly.ts`) emits
`<tool_output trusted="false" tool="..." id="...">`, so the trust label and the
tool identity travel as text inside the payload they describe. This is the
precondition `synthesis-telephone-game-per-claim-confidence` explicitly flags
as possibly not holding in text-only agent protocols. It does not hold here.
The mitigation is that the label is *defence in depth* rather than the only
defence: `escapeNestedTags` neutralises a forged `<tool_output>` in the
content, and policy enforcement happens in code before dispatch, so an agent
that ignores or spoofs the tag still cannot execute a denied tool.

## Invariant 4 — code-checked gates replace agent self-certification

**Status: violated when audited; fixed on `nightly/2026-08-21-improvements`.**

`validateExternalTarget` (`src/cli/validate-target.ts`) actually runs the
target's `npm install`, `npm run lint`, and `npm run build` and records each
outcome into `SofieContext.targetSummary` as `installOk` / `lintOk` / `buildOk`.
That is a genuine code-checked gate: the harness watches the commands run and
does not take anyone's word for the result.

The gate was then discarded. `answerRoutineQuestion` (`src/sofie/authority.ts`)
only ever tested those fields for *presence* — `detectInsufficientEvidence`
asked whether they were `typeof boolean`, and the verdict branches asked
whether `targetSummary` existed at all. The values were never read. A target
whose lint and build both failed produced:

```
verdict               = answer
summary               = Sofie review passes within bounded authority
                        using harness-local validation evidence.
closureRecommendation = complete
```

Fixed by `detectFailedAcceptanceGate` / `failedAcceptanceGateNames`: any
recorded `false` forces `verdict: "caution"` and
`closureRecommendation: "needs-human"`, and adds a structured
`acceptanceGateFailed=<names>` line to the evidence details. Verdicts are
unchanged when every recorded gate passed or when no target validation ran.
Regression coverage: `tests/unit/sofieAuthority.test.ts`.

Note what is *not* a violation: `answerRoutineQuestion` is deterministic code
reading recorded artifacts, not an agent judging its own work. The bug was that
the gate result was collected and ignored, not that an agent got to self-certify.

## Invariant 5 — every event streams into a trace store live

**Status: satisfied.**

`emitEvent` (`src/loop/query.ts`) awaits `tape.writeEvent(event)` and, when
`tracePath` is set, awaits an `appendJsonl` of `{ at, sessionId, event }` — per
event, before the loop proceeds. Nothing is buffered to the end of the run, so a
crashed run leaves a prefix of the trace rather than nothing. `appendEffectRecord`
and `appendPolicyDecision` follow the same append-per-record shape, and
`src/cli/inspect.ts` reads a run back phase-by-phase rather than as a transcript.

## Stated trade-off — retries as cheap corrections, not cold restarts

**Status: deliberate divergence. Not a defect.**

The pattern argues retries should resume the live session. This repo
deliberately refuses to: `classifyRetryableModelError` returns
`model_midstream_after_persist` as soon as `hasPersistedEvent` is true, and
`shouldRetryModelInvocation` retries **only** `model_open_transient`. A failure
after the first persisted event always fails closed.

That is the right call *here*. The tape is a hash chain
(`verifyRecordChain`), and resuming a partially-consumed model stream would
append events that no longer follow deterministically from the prefix already
committed — trading replay fidelity, which is this repo's entire value
proposition, for cheaper retries. Recorded so a later pass does not "fix" it.

---

## Cross-checks from the other two articles

### "Lost its environment between shell calls and never noticed"

**Status: satisfied.** Environment is captured once and passed explicitly, never
implicitly inherited per call. `HermesAdapter` builds
`env: { ...process.env, ...options.env }` once at session creation
(`src/hermes/adapter.ts`) and every later spawn reuses that snapshot via
`session.env`; `SpawnHermesTransportInput` (`src/hermes/transport.ts`) makes
both `cwd` and `env` **required** fields, so a caller cannot silently fall
through to ambient state. `buildHookEnv` (`src/hooks/shellHook.ts`) goes
further and builds an allowlist — `PATH`, `HOME`, `PI_HOOK_EVENT`,
`PI_SESSION_ID` — so an untrusted hook never inherits harness secrets, and each
hook runs in a fresh `mkdtemp` scratch dir rather than the session workdir.

One latent inconsistency, recorded but not changed: `resolveExecutable`
(`src/hermes/transport.ts`) resolves the binary against
`env.PATH ?? process.env.PATH`. A caller who deliberately passes a `PATH`-less
env to sandbox a child would have the executable located using the *harness's*
`PATH` and then spawned with an env that lacks it. Not reachable today — the
only caller always spreads `process.env` — so this is a finding, not a fix.

### Provenance across the capture → replay → verify hop

**Status: partial.** Structured provenance survives the hop: `ProvenanceManifest`
carries `provider`, `model`, `repoGitSha`, `loopGitSha`, `policyDigest`, and
`piMdDigest` as typed fields, and `TapeHeader` independently re-carries
`loopGitSha`, `policyDigest`, and `costTableVersion` inside the hash chain, so
tampering with them breaks verification. `EffectRecord` carries pre/post hashes
per path rather than a prose description of the change.

The gap was sanitization. `sanitizeToolOutput` measures exactly how lossy the
tool-output hop was — which rewrites fired, and the byte count either side — and
returns a versioned `SanitizationRecord`. The loop destructured only `wrapped`
and dropped the record, so `SanitizationRecord` was a schema with no producer.
A 200KB tool output reached the tape as 65KB with the loss recorded **only** as
the prose string `[...truncated 134409 bytes...]` inside the payload, and an
escaped `<system>` tag left no trace at all. `LoopResult.sanitizations` now
carries the records and each rewrite increments a `sanitize.<kind>` counter.
Additive: the tape, its hash chain, and the canonical golden digest are
unchanged.

Still open: the records are returned from the loop but not yet persisted to
their own artifact alongside `effects.jsonl` and `policy.jsonl`. See
`docs/NIGHTLY-BACKLOG.md`.
