# Workday Software Factory Runtime Role

Date: 2026-07-25
Source: Apple Notes → Workday Software Factory plan in `/Users/jaywest/hermes-harness-missioncontrol/docs/plans/2026-07-12-apple-notes-to-workday-software-factory-plan.md`

## Decision

Pi is not the user-facing Workday software factory control plane. MissionControl owns factory state, work item bindings, approvals, operator read models, evals, and receipt visibility.

Pi's role is narrower and useful:

- supervise bounded worker execution
- enforce runtime contracts
- preserve traces and event history
- expose Hermes bridge health/meta/run records
- validate source-of-truth and receipt semantics
- provide a runtime lane for high-control execution when MissionControl dispatches work

## Control-plane split

```text
Jay / Hermes
  -> thinking, routing, synthesis, operator-facing interaction
MissionControl
  -> missions, runs, factory read models, approvals, work item bindings
Pi Harness
  -> governed execution runtime, bridge supervision, trace persistence
Worker / Hermes process
  -> bounded task execution inside an envelope
```

## Factory contract expectations for Pi

When MissionControl dispatches factory work to a Pi lane, the task envelope should carry:

- external work item reference: Jira/Workday key, hierarchy, status, team, assignee
- source-of-truth declaration: where final state must land and whether writeback is required
- connector capability scopes: opaque `secret_ref`, allowed operations, risk level
- loop policy: loop type, evaluator, max attempts, runtime, cost, approval thresholds
- context packet URI: issue data, acceptance criteria, repo scope, linked docs, prior attempts
- receipt packet URI target: artifacts, checks, evidence, residual risks, follow-up tasks

Pi should treat those as runtime constraints, not strategy suggestions.

## What Pi should not own

- Jira/Workday board intake strategy
- throughput dashboards
- operator approval UX
- long-term factory state
- raw Jira or Workday credentials
- autonomous external writeback

## Safe next Pi slice

Add schema/read-model support for MissionControl-dispatched factory envelopes after MissionControl's fixture slice lands:

1. Accept a factory-flavored task envelope in bridge execution tests.
2. Persist source-of-truth, connector scope, loop policy, context packet URI, and receipt target into run records.
3. Confirm `/runs/:id` and `/runs/:id/events` preserve those fields without leaking secrets.
4. Add one golden fixture for a Jira story executing through the bridge in dry-run/no-writeback mode.

## Verification target

Use the existing bridge-focused path first:

```bash
npx vitest run tests/unit/hermesBridge.test.ts tests/unit/hermesAdapter.test.ts tests/unit/hermesSupervisor.test.ts
npm run typecheck
npm run build
```

Do not let unrelated benchmark instability block this slice if the bridge, adapter, supervisor, typecheck, and build pass.
