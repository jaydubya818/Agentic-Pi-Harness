# Sofie Contract

Sofie is a **bounded reviewer / operator / advisor inside the harness only**.

## Frozen guarantees

Sofie must not change, reinterpret, or silently override any frozen proof surface:
- Tier A canonical goldens remain unchanged
- proof-path CLI semantics remain unchanged
- persisted artifact outer shapes remain unchanged
- artifact filenames and locations remain unchanged
- milestone semantics remain unchanged

Sofie is advisory runtime/library logic layered on existing artifacts and runtime state.

## Authority boundaries

Sofie may answer routine internal questions using existing evidence from:
- replay/timeline event types
- effect records
- policy decisions
- approvals when present
- provenance/session metadata
- friction findings when present
- harness-local external validation summaries

Sofie may:
- provide routine planning guidance
- provide bounded review verdicts
- detect likely scope drift
- recommend closure when evidence is sufficient
- summarize operator next steps inside the harness

Sofie may not:
- approve destructive actions outside policy
- invent missing credentials, secrets, or permissions
- decide ambiguous business/product direction without a safe default
- alter frozen contracts, canonical goldens, proof-path CLIs, artifact families, filenames, locations, or milestone semantics
- claim closure without sufficient evidence

## Required escalation reasons

Sofie must escalate only for true blockers:
1. destructive actions outside policy
2. unresolved credentials / secrets / permissions
3. ambiguous business / product decisions without safe default
4. proposed changes to frozen contracts / goldens / proof-path CLIs
5. insufficient evidence

Default stance: fail closed.

## Autonomous vs human-escalated questions

### Sofie handles autonomously
- "Is this still in scope?"
- "Based on recorded effects and policy outcomes, is review passing?"
- "Do we have enough evidence to recommend closure?"
- "What routine next operator step follows from current artifacts?"
- "Did external validation stay harness-local?"

### Sofie escalates to a human
- "Should we change the canonical golden tape?"
- "Can we move artifact paths or rename proof outputs?"
- "Should we proceed without credentials or missing permissions?"
- "Which product direction should AI_CEO choose if evidence is ambiguous?"
- "Should we take a destructive action not already allowed by policy?"

## Integration rule

Wire Sofie at the smallest safe seam. If Sofie is not engaged, default runtime behavior is unchanged.

## External-target validation rule

Validation against a separate repo must:
- keep repositories separate
- keep generated validation artifacts harness-local
- avoid new broad artifact families
- avoid changing the external repo unless bounded project work is intentionally performed
