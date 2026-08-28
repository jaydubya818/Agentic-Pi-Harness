# Agentic Operating Model Crosswalk

Date: 2026-07-10
Source synthesis: `/Users/jaywest/Agentic-KB/wiki/syntheses/synthesis-agentic-engineering-operating-model.md`

## Verdict

Pi is strong as a governed execution supervisor, but the user-facing operating model needs a naming correction:

- Hermes should remain Jay's visible control surface / navigator.
- Pi should be treated as a supervised runtime/governor lane for bounded execution unless Jay explicitly promotes it for a specific mission.

The repo currently describes:

- Pi as supervisor / orchestrator
- Hermes as governed worker
- bridge as required control-plane boundary

That is valid for the Pi↔Hermes execution contract, but it can conflict with Jay's broader operating model if it makes Pi another user-facing orchestrator competing with Hermes.

## Alignment scorecard

| Principle | Current state | Status |
|---|---|---|
| Artifact-native completion | Strong: artifacts, traces, tapes, effects, provenance, policies are first-class | Strong |
| Supervisor control | Strong: Pi owns lifecycle, policy, retries, interrupts, cancellations, acceptance criteria | Strong |
| Permissioned context/tools | Strong: explicit constraints, allowlists, denylists, approval policy | Strong |
| System of record clarity | Good: Agentic-KB and mission outputs/traces are named; Pi validates artifacts | Good |
| Verification receipts | Strong: verify/replay/what-changed/inspect flows are central | Strong |
| One visible orchestrator | Needs clarification: repo-local Pi supervisor should not imply Jay must operate Pi directly | Gap |
| Outcome metrics beyond activity/cost | Partial: cost tracking exists; outcome metric layer is not explicit | Gap |
| Source-of-truth declaration per run | Partial: artifacts_expected exists, but final truth backend is not explicit | Gap |
| Learning loop | Partial: promotion lineage exists; skill/KB learning candidates should be explicit | Gap |

## Recommended repo changes

### 1. Clarify role language

Add this distinction to README / contract docs:

```text
System-level control surface: Hermes/Jay-facing orchestrator.
Execution-level supervisor: Pi governs bounded worker execution through a contract.
```

This preserves Pi's hard-control value without creating user-facing orchestration sprawl.

### 2. Extend task envelope with source-of-truth metadata

Current envelope has `artifacts_expected`; add final-state semantics:

```json
"source_of_truth": {
  "kind": "github|agentic_kb|taskmaster|filesystem|cron|external_system",
  "uri": "...",
  "writeback_required": true,
  "verification_required": true
}
```

Why: artifacts prove something was produced; source-of-truth declares where the work must land.

### 3. Add outcome metric layer next to cost metrics

Cost tracking exists. Add outcome tracking so the harness does not optimize for cheap activity.

Candidate shape:

```ts
interface OutcomeMetric {
  kind: 'cycle_time' | 'review_burden' | 'defect_rate' | 'handoff_removed' | 'operator_time_saved' | 'business_outcome';
  baseline?: string;
  observed?: string;
  evidencePath?: string;
  confidence: 'low' | 'medium' | 'high';
}
```

### 4. Add learning-candidate receipts

At run completion, require one of:

```json
"learning_candidate": {
  "state": "proposed|none",
  "target": "skill|kb|test|runbook|memory",
  "reason": "...",
  "requires_review": true
}
```

This keeps self-improvement reviewed, not automatic.

## Best next implementation slice

Small schema-first change:

1. Add `source_of_truth` and optional `outcome_metrics` to contract schema/types.
2. Add tests proving old fixtures migrate or reject cleanly.
3. Update README/contract docs with the Hermes-visible / Pi-supervisor role distinction.
4. Add one golden fixture showing artifact + source-of-truth + outcome metric receipt.

Do not rewrite the architecture. The foundation is good; the missing layer is outcome/source-of-truth semantics.
