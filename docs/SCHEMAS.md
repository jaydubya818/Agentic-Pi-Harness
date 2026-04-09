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

## Current schema modules under `src/schemas/`

### Core helpers
- `canonical.ts` — canonical framing + hashing helpers used by tape and digest code
- `index.ts` — central re-export surface for schema modules
- `parse.ts` — shared parse helper used for schema-validated reads

### Session / provenance / checkpoint
- `sessionContext.ts` — persisted session-level identity and runtime context shape
- `provenanceManifest.ts` — session start manifest written for the canonical run
- `checkpoint.ts` — crash-safe loop end state (`sessionId`, `turnIndex`, `messageCount`, `lastEventAt`, `stopReason`)
- `metricsSnapshot.ts` — persisted counters snapshot written at session end

### Replay tape / stream
- `streamEvent.ts` — normalized canonical stream events used by the mock adapter and loop
- `tapeRecord.ts` — replay tape header and event records, including hash-chain fields

### Effect / policy / audit sidecars
- `effectRecord.ts` — effect log record for mutating tool calls
- `policyDecision.ts` — placeholder policy decision record used in Tier A
- `toolAuditRecord.ts` — tool audit record schema reserved for persisted tool-sidecar output
- `sanitizationRecord.ts` — sanitization sidecar schema for tool-output containment metadata

## Current Tier A artifact families

### 1) Session / provenance / checkpoint
Written during `run` for the canonical golden path:
- `sessions/<sessionId>/provenance.json`
- `sessions/<sessionId>/checkpoint.json`
- `sessions/<sessionId>/metrics.json`

Schema modules:
- `provenanceManifest.ts`
- `checkpoint.ts`
- `metricsSnapshot.ts`
- `sessionContext.ts`

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

Tier A uses placeholder approvals only.

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
A simple persisted counters snapshot is written at session end.

Schema module:
- `metricsSnapshot.ts`

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

Current Tier A posture is intentionally conservative:
- no new migrator work is included in this release
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

## Schema-drift guard

Local pre-commit guard:
- `scripts/check-schema-drift.mjs`

Rule:
- if files under `src/schemas/` change, `docs/SCHEMAS.md` must be updated and staged in the same commit

This release uses that guard as a documentation-alignment check for the Tier A contract.
