# Governed Execution Model V1

## 1. Purpose

In this codebase, **governed execution** means agent work that is routed through a supervised control plane with explicit policy enforcement, persistence, and traceability.

A governed run must have:
- a stable execution boundary
- validated request input
- persistent run/event state
- observable lifecycle events
- enforced knowledge/write boundaries
- auditable outputs and promotion flow

The **bridge** is the control-plane boundary because it is the single place where the runtime can consistently enforce:
- request validation
- run state transitions
- event emission
- KB/Wiki path policy
- preflight denial capture
- persistent reads after restart

Without the bridge, execution can bypass governance and split runtime behavior.

---

## 2. Current execution model

### Pi
Pi is the:
- supervisor
- orchestrator
- governor
- reviewer/promoter of canonical knowledge

### Hermes
Hermes is a governed worker:
- executes tasks
- reads broadly
- writes only within approved non-canonical zones when running under governance
- produces candidate outputs for Pi review/promotion

### Bridge
The bridge is the **required path for governed execution**.

Governed execution now routes through:
- `src/hermes/httpBridge.ts`
- higher-level bridge client/orchestration wrappers

### Dev-only direct paths
Some direct paths still exist for local utility/debugging:
- `hermes-demo`
- `hermes-smoke`
- direct adapter unit tests

These are explicitly isolated as **dev-only** and are not the governed production path.

---

## 3. Governed vs non-governed execution

## Governed execution
Governed execution includes:
- supervisor/orchestration runs
- `hermes-run`
- any execution intended to obey runtime policy and produce governed artifacts

These **must go through the bridge**.

## Non-governed execution
Non-governed execution includes:
- local demos
- local smoke/debug paths
- direct adapter unit coverage

These may remain direct only if they are clearly treated as:
- dev-only
- test-only
- non-canonical / non-governed

---

## 4. Enforcement currently in place

The bridge-governed path currently enforces:

- **contract validation**
  - legacy request validation
  - Contract V2 task/result/event validation

- **persistent run state**
  - sessions
  - runs
  - events
  - restart-safe reads

- **structured events**
  - Contract V2 event model
  - normalized read APIs
  - SSE support already implemented

- **KB/Wiki access policy**
  - Hermes write allowlist
  - Pi-only canonical zones

- **immutable request handling**
  - mission `request/` paths are created once and treated as immutable

- **append-only traces**
  - Hermes trace writes are create/append only, not overwrite

- **queue discipline**
  - Hermes may create queue items
  - Hermes may not mutate existing queue items in place

- **frontmatter validation**
  - required for KB markdown artifacts where policy requires it

- **delete/tombstone rules**
  - Hermes cannot delete in `Agentic-KB`
  - Pi uses tombstone/archive-style handling for governed artifacts

- **promotion lineage**
  - Pi promotion helper writes canonical output plus approval lineage

- **persisted preflight denials**
  - invalid/preflight-denied executions are recorded even if a run never starts

- **bridge-only mode**
  - direct non-bridge governed-style paths can be blocked unless explicitly bypassed for dev use

---

## 5. KB/Wiki model summary

### `~/Agentic-KB`
Governed operational memory and system of record.

Characteristics:
- canonical/trusted once promoted
- Pi-governed
- Hermes write-bounded to non-canonical zones only

### `~/My LLM Wiki`
Shared working knowledge and broader synthesis space.

Characteristics:
- untrusted by default
- broad research/scratch/synthesis area
- shared read/write space

### Authority split
- **Pi**: may write both repos; only Pi promotes canonical truth
- **Hermes**: may read both repos; may write only approved non-canonical zones in `Agentic-KB`, and freely in `My LLM Wiki`

---

## 6. Bridge-only mode

### `BRIDGE_ONLY_GOVERNED_EXECUTION=true`
When enabled:
- governed execution is expected to route through the bridge
- direct dev-only adapter utilities fail fast unless explicitly bypassed

### `DEV_BYPASS_DIRECT_HERMES=true`
When set alongside bridge-only mode:
- allows intentional use of direct dev-only paths such as demo/smoke utilities

### Intended usage
Use bridge-only mode when you want to ensure governed execution cannot silently drift back to direct adapter execution.

---

## 7. Remaining intentional exceptions

These remain direct by design:

- `hermes-demo`
  - dev-only utility
  - explicitly warns / blocked in bridge-only mode unless bypassed

- `hermes-smoke`
  - dev-only utility
  - explicitly warns / blocked in bridge-only mode unless bypassed

- direct unit-test adapter coverage
  - retained for low-level adapter behavior tests
  - not treated as governed production execution

---

## 8. Reuse guidance

To apply this model to another worker/runtime such as **Paperclip**:

### Copy directly
- bridge as control-plane boundary
- governed vs dev-only split
- persistent run/event state model
- preflight denial persistence
- KB/Wiki path policy model
- bridge-only mode
- promotion/tombstone pattern

### Adapt per worker
- worker-specific request/result envelopes
- transport/spawn details
- worker prompt or API contract
- runtime-specific artifact expectations
- worker-specific structured event mapping

### Core rule to preserve
Do not let the worker runtime become its own governance boundary.
Keep governance in the supervisor/bridge layer.

---

## 9. Short implementation inventory

Main modules/files involved:

- `src/hermes/httpBridge.ts`
  - governed execution boundary
  - request handling
  - policy preflight
  - V2 lifecycle/events

- `src/hermes/bridgeState.ts`
  - persistent sessions/runs/events
  - persisted preflight denials

- `src/hermes/kbAccessPolicy.ts`
  - KB/Wiki path classification
  - write enforcement
  - queue rules
  - frontmatter validation
  - delete/tombstone/promotion helpers

- `src/hermes/contractV2.ts`
  - Contract V2 schemas and state/event definitions

- `src/hermes/bridgeClient.ts`
  - higher-level execution routed through bridge

- `src/orchestration/hermesSupervisor.ts`
  - supervisor path now bridge-routed

- `src/cli/hermes-run.ts`
  - governed CLI path using supervisor/bridge route

- `src/cli/hermes-demo.ts`
- `src/cli/hermes-smoke.ts`
  - explicit dev-only direct paths

- `KB_ACCESS_POLICY_V1.md`
  - KB/Wiki policy reference

- `PI_HERMES_CONTRACT_V2.md`
  - governed execution contract reference

---

## 10. Open follow-ups

Real deferred items that still matter:

- emit/persist a fuller set of KB policy telemetry from helper-level enforcement into bridge-visible run traces when a run exists
- consider routing more tooling through a shared bridge client instead of keeping small direct utilities
- tighten archive/move workflows beyond current tombstone/delete-deny behavior where needed
- apply the same governed bridge pattern to additional workers/runtimes (for example Paperclip)

---

This is the current implemented model, not a future ideal. It is the reference shape for governed worker integration in this codebase.
