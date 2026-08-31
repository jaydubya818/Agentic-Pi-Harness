# Schemas, Versioning & Canonicalization

This release documents the **Tier A / canonical golden-path** schema surface only.

Tier B and deferred schema families may still exist elsewhere in the repo, but they are **not part of the Tier A release contract** described here.

## Rule: every persisted Tier A type has a Zod schema + `schemaVersion`

Persisted means anything written to disk for the canonical golden path, read back during verification/replay, or hashed as part of the deterministic audit trail.

Current Tier A persisted families are:
- session/provenance/checkpoint
- replay tape
- effect log
- policy decisions
- sanitization / tool audit sidecar schemas
- stream events
- metrics snapshot

Each schema lives in `src/schemas/<name>.ts` and is re-exported from `src/schemas/index.ts`.

> **Where the rule does not hold today.** Three of the modules listed below are
> declared but inert, so this section describes the intended surface rather
> than the current one:
>
> | Module | State |
> | --- | --- |
> | `metricsSnapshot.ts` | `metrics.json` **is** written, but as the bare counter map — no `schemaVersion`, no validating reader. See family 7. |
> | `sessionContext.ts` | No artifact of this shape is written or read anywhere. |
> | `toolAuditRecord.ts` | No sidecar file is emitted; already noted under family 5. |
>
> `src/schemas/index.ts` re-exports all three, but `src/index.ts` — the package
> entry named by `package.json#main` — exports only `hermes/index.js` and
> `orchestration/hermesSupervisor.js`, so none of them reach a package
> consumer either.

## Current schema modules under `src/schemas/`

### Core helpers
- `canonical.ts` — canonical framing + hashing helpers used by tape and digest code
- `index.ts` — central re-export surface for schema modules
- `parse.ts` — shared parse helper used for schema-validated reads

> **0.4.0 note (canonical helpers):** `canonical.ts` gained a `FrameTag` type
> alias and a streaming helper `sha256HexFramed(frame, value)` that feeds the
> frame tag + separator + canonical JSON directly into a single `createHash`
> call. Output is byte-identical to `sha256Hex(framedCanonical(frame, value))`;
> committed `goldens/canonical/` digests are unchanged. No persisted-schema
> surface changed, so no `schemaVersion` bump is required.

> **0.70.3 note (canonical helpers):** `canonical.ts` gained `compareCodeUnits`,
> the ordering primitive documented under "Ordering rule for sorted fields"
> below. It replaces `localeCompare` in the effect recorder and the Hermes
> artifact scan. No persisted-schema surface changed and no field was added or
> removed, so no `schemaVersion` bump is required. `EffectRecord.paths` and the
> artifact list may now be emitted in a different order than a pre-0.70.3 build
> produced for the same inputs; committed `goldens/canonical/` digests are
> unchanged.

### Session / provenance / checkpoint
- `sessionContext.ts` — **declared, not persisted.** No artifact of this shape is written or read; `SessionContextSchema` and `SESSION_CONTEXT_SCHEMA_VERSION` have no reference anywhere outside their own module. (The `session.json` files under a Hermes runtime dir are bridge session records written by `src/hermes/adapter.ts` and are a different shape entirely.)
- `provenanceManifest.ts` — session start manifest written for the canonical run; validated on both write and read by `writeProvenance` / `readProvenance`
- `checkpoint.ts` — crash-safe loop end state (`sessionId`, `turnIndex`, `messageCount`, `lastEventAt`, `stopReason`)
- `metricsSnapshot.ts` — **declared, not persisted.** `metrics.json` is written as the bare counter map (`src/cli/run.ts`, `safeWriteCanonicalJson(..., result.counters)`), not as the `{ schemaVersion, sessionId, counters, capturedAt }` envelope this module defines. Nothing produces or consumes `SessionMetrics`.

### Replay tape / stream
- `streamEvent.ts` — normalized canonical stream events used by the mock adapter and loop
- `tapeRecord.ts` — replay tape header and event records, including hash-chain fields

### Effect / policy / audit sidecars
- `effectRecord.ts` — effect log record for mutating tool calls
- `policyDecision.ts` — persisted policy decision record supporting both `provenanceMode: "placeholder"` and `provenanceMode: "real"` without changing the outer artifact shape
- `toolAuditRecord.ts` — tool audit record schema reserved for persisted tool-sidecar output
- `sanitizationRecord.ts` — sanitization sidecar schema for tool-output containment metadata

## Current Tier A artifact families

### 1) Session / provenance / checkpoint
Written during `run` for the canonical golden path:
- `sessions/<sessionId>/provenance.json`
- `sessions/<sessionId>/checkpoint.json`
- `sessions/<sessionId>/metrics.json`

Schema modules:
- `provenanceManifest.ts` — describes `provenance.json`
- `checkpoint.ts` — describes `checkpoint.json`
- `metricsSnapshot.ts` — does **not** describe `metrics.json`; see the module note above
- `sessionContext.ts` — describes no artifact in this list; see the module note above

### 2) Replay tape
Written to:
- `tapes/<sessionId>.jsonl`

The tape contains:
- one header record
- ordered event records
- `prevHash` / `recordHash` chain fields

Schema modules:
- `streamEvent.ts`
- `tapeRecord.ts`

### 3) Effect log
Written to:
- `effects/<sessionId>.jsonl`

Tier A writes one `EffectRecord` for the single canonical mutating tool call.

Schema module:
- `effectRecord.ts`

### 4) Policy decisions
Written to:
- `sessions/<sessionId>/policy.jsonl`

Tier A uses placeholder approvals only. Tier B Milestone 1 adds real policy decisions while preserving the same persisted field names and overall record shape.

Current compatibility contract:
- placeholder mode persists `provenanceMode: "placeholder"`
- real mode persists `provenanceMode: "real"`
- `result` remains `"approve" | "deny" | "ask"`
- Tier B Milestone 2 may set `hookDecision` when a `PreToolUse` hook denies after base policy evaluation
- `mutatedByHook` remains `false` in Milestone 2
- `approvalRequiredBy` remains `null` in Milestone 2 hook mediation
- no new artifact family or replay tape event type is introduced for hooks in Milestone 2

Schema module:
- `policyDecision.ts`

### 5) Sanitization / tool audit sidecars
These schemas are part of the persisted schema surface and are kept versioned even though the Tier A golden path does not yet emit separate sidecar files for them.

Schema modules:
- `sanitizationRecord.ts`
- `toolAuditRecord.ts`

### 6) Stream events
The normalized event stream is the canonical replay unit and is embedded inside tape event records.

Schema module:
- `streamEvent.ts`

### 7) Metrics snapshot
A simple persisted counters snapshot is written at session end, to
`sessions/<sessionId>/metrics.json`.

It is written as the bare `counters` map — a flat `Record<string, number>` with
no envelope — so unlike every other family in this list it carries **no
`schemaVersion` field**, and no reader validates it. This is the one live
exception to the rule at the top of this document.

Schema module:
- `metricsSnapshot.ts` — defines the envelope this artifact does *not* currently
  use. Adopting it would change the bytes of `metrics.json` and therefore the
  canonical golden digests, so it is a contract change rather than a cleanup.
  Tracked in `docs/NIGHTLY-BACKLOG.md` (2026-08-23).

## Read path

All persisted Tier A reads should go through schema validation.

Current helpers/readers include:
- `parseOrThrow(...)` in `src/schemas/parse.ts`
- `readTape(...)` in `src/replay/recorder.ts`
- `readEffectLog(...)` in `src/effect/recorder.ts`
- `readPolicyLog(...)` in `src/policy/decision.ts`
- `readProvenance(...)` in `src/session/provenance.ts`

The Tier A rule is: **no unchecked deserialization for persisted contract data**.

## Migration posture for Tier A

Current Tier A / early Tier B posture is intentionally conservative:
- no new migrator work is included in this release line
- replay/verification should **fail closed** on unsupported or invalid persisted data
- migration is allowed **only if** a tested migrator exists

In other words: if a future schema version changes and no tested migrator is present, the correct behavior for this Tier A release line is to reject the artifact rather than guess.

## Canonicalization (for hashing)

Canonicalization is used for deterministic hashing in the Tier A proof path.

Current framing usage includes:
- `pi-tape-v1` for replay tape records
- policy/provenance digest inputs as implemented by current runtime helpers

Implementation lives in:
- `src/schemas/canonical.ts`

Tier A depends on canonical hashing for:
- replay tape hash-chain verification
- stable digest generation used by persisted session artifacts

### Ordering rule for sorted fields

Any list that is persisted into an artifact and is expected to be stable
across runs and across hosts must be sorted with `compareCodeUnits` from
`src/schemas/canonical.ts` (UTF-16 code unit order — the same total order
`Array#sort` applies with no comparator).

`String.prototype.localeCompare` must not be used for this. It is not a total
order over distinct strings: code points that ICU treats as ignorable at
primary strength (U+00AD, U+200B, …) make two different names compare equal,
and because `Array.prototype.sort` is stable those elements then retain their
input order — which for a directory scan is `readdir` order. Its result is
also a function of the ICU data the Node binary was built against
(full-icu / small-icu / system-icu, plus ICU version), so two hosts can order
one file set two different ways.

Current call sites: `normalizePaths` in `src/effect/recorder.ts` (the
`EffectRecord.paths` list and the `unifiedDiff` concatenation order) and
`detectArtifacts` in `src/hermes/adapter.ts` (traversal order, which under
`maxArtifacts` truncation determines which artifacts are recorded at all).

## Schema-drift guard

Local pre-commit guard:
- `scripts/check-schema-drift.mjs`

Rule:
- if files under `src/schemas/` change, `docs/SCHEMAS.md` must be updated and staged in the same commit

This release uses that guard as a documentation-alignment check for the Tier A contract.

## Sofie phase note
- Re-exported Sofie authority types from `src/schemas/index.ts`.
- No persisted artifact outer shape changed.
