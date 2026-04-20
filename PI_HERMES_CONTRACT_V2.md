# PI_HERMES_CONTRACT_V2

Status: Draft for implementation  
Applies to: Agentic Pi Harness ↔ Hermes worker integration  
Audience: Runtime, bridge, orchestration, testing, and observability engineers

---

## 1. Purpose and design goals

`PI_HERMES_CONTRACT_V2` defines the machine-readable execution contract between:

- **Pi** — the supervisor/orchestrator/control plane
- **Hermes** — the governed worker agent/execution plane

This contract exists to make Pi↔Hermes execution **predictable under supervision**.

### Primary goals

1. **Determinism**
   - identical or equivalent inputs should produce contract-compatible behavior
   - runtime behavior should be explainable through persisted state and events

2. **Observability**
   - every meaningful transition, artifact, and failure should be inspectable
   - runs must be debuggable from persisted records, not only terminal text

3. **Recoverability**
   - sessions, runs, and event streams must survive bridge restarts
   - supervisor decisions must remain reconstructable after process failure

4. **Artifact truth**
   - artifacts are first-class outputs, not incidental side effects
   - Pi validates artifact claims against the filesystem and contract

5. **Supervisor control**
   - Pi owns lifecycle, policy, retries, interrupts, cancellations, and acceptance criteria
   - Hermes executes within an explicit envelope and returns structured results

### Non-goal

Hermes is **not** treated as a stateless API. Hermes is a **supervised worker process** with:
- session continuity
- runtime state
- observable progress
- governed side effects
- durable artifacts

This contract is designed for a stateful supervised-worker model, not best-effort chat completion.

---

## 2. Core principles

| Principle | Meaning | Consequence |
|---|---|---|
| Versioned contract | All persisted request/result/event shapes are versioned | Runtime must reject incompatible schema versions or explicitly migrate them |
| Explicit lifecycle state machine | Every run occupies a single well-defined state | Invalid transitions are contract violations |
| Artifact-first execution | Artifact outputs are part of the contract, not optional chatter | Pi validates artifact reality, completeness, and integrity |
| Correlated eventing | Every event carries stable identifiers | Logs, traces, artifacts, and failures can be joined reliably |
| Failure-class awareness | Failures are categorized explicitly | Retry policy, operator action, and reporting become deterministic |
| Policy-friendly design | Request envelope carries policy-relevant constraints | Pi can preflight and supervise without reverse-engineering intent |
| Testable design | Golden missions and contract tests are first-class | Runtime behavior can be proven, not hand-waved |

---

## 3. Task envelope schema

This envelope is sent from **Pi to Hermes**.

### 3.1 Field definitions

| Field | Type | Required | Description |
|---|---|---:|---|
| `schema_version` | string | yes | Contract version. For this spec use `"2.0"`. |
| `request_id` | string | yes | Unique id for this request attempt. Stable across transport delivery of the same logical request. |
| `run_id` | string | yes | Stable logical run id owned by Pi. A retried run keeps the same `run_id`; retries increment metadata. |
| `mission_id` | string | yes | Parent mission or workflow identifier. Allows grouping multiple runs/steps. |
| `session_id` | string | yes | Pi-owned continuity session id for the worker session. |
| `execution_id` | string | yes | Unique execution instance id for this concrete run attempt. |
| `task_type` | string | yes | Categorical task class, e.g. `repo_inspection`, `code_edit`, `test_run`, `research`. |
| `goal` | string | yes | One-sentence mission objective in supervisor language. |
| `instructions` | array<string> | yes | Ordered imperative instructions Hermes must follow. |
| `constraints` | object | yes | Structured execution constraints. See below. |
| `allowed_tools` | array<string> | yes | Tools explicitly allowed for this run. Empty means allow none unless policy overrides. |
| `disallowed_tools` | array<string> | no | Tools explicitly forbidden even if globally available. |
| `workdir` | string | yes | Absolute path Hermes must treat as working directory boundary. |
| `repo` | object | no | Structured repo context. See below. |
| `branch` | string | no | Requested branch/worktree branch context when relevant. |
| `timeout_seconds` | integer | yes | Hard supervisor timeout. |
| `budget` | object | no | Compute, token, cost, or step-budget hints and limits. |
| `artifacts_expected` | array<object> | yes | Expected artifacts with type/role/path requirements. |
| `approval_policy` | object | yes | Approval requirements and escalation behavior. |
| `priority` | string | yes | `low`, `normal`, `high`, or `urgent`. |
| `metadata` | object | no | Additional structured metadata, tags, origin, retry count, etc. |

### 3.2 `constraints` object

| Field | Type | Required | Description |
|---|---|---:|---|
| `network_access` | boolean | yes | Whether network access is allowed. |
| `write_access` | boolean | yes | Whether filesystem writes are allowed. |
| `max_steps` | integer | no | Soft step/tool-call budget. |
| `max_subprocess_depth` | integer | no | Maximum nested process/delegation depth. |
| `path_allowlist` | array<string> | no | Absolute paths Hermes may read/write beneath. |
| `path_denylist` | array<string> | no | Absolute paths Hermes must not touch. |
| `side_effect_class` | string | no | `none`, `readonly`, `local_write`, `external_effect`, `mixed`. |
| `requires_isolation` | boolean | no | Whether Pi expects isolated worktree/scratch execution. |

### 3.3 `repo` object

| Field | Type | Required | Description |
|---|---|---:|---|
| `root` | string | yes if present | Absolute repo root path. |
| `vcs` | string | no | Usually `git`. |
| `remote` | string | no | Canonical remote URL or name. |
| `commit_sha` | string | no | Input commit SHA for reproducibility. |
| `worktree_path` | string | no | Absolute isolated worktree path if Pi provisioned one. |

### 3.4 `budget` object

| Field | Type | Required | Description |
|---|---|---:|---|
| `max_tokens` | integer | no | Upper bound for model token usage if applicable. |
| `max_cost_usd` | number | no | Soft cost ceiling. |
| `max_tool_calls` | integer | no | Maximum tool-call count. |
| `max_runtime_seconds` | integer | no | Soft runtime budget separate from hard timeout. |

### 3.5 `artifacts_expected` item

| Field | Type | Required | Description |
|---|---|---:|---|
| `type` | string | yes | Contract artifact type, e.g. `summary`, `result`, `manifest`, `trace`. |
| `role` | string | yes | Semantic role, e.g. `primary_result`, `supporting_log`. |
| `path` | string | yes | Absolute expected output path. |
| `required` | boolean | yes | Whether absence is a contract violation. |
| `description` | string | no | Human-readable purpose. |

### 3.6 `approval_policy` object

| Field | Type | Required | Description |
|---|---|---:|---|
| `mode` | string | yes | `never`, `on_dangerous_action`, `always_for_writes`, `supervisor_defined`. |
| `allow_interrupt` | boolean | yes | Whether Pi may interrupt mid-run. |
| `allow_cancel` | boolean | yes | Whether Pi may cancel mid-run. |
| `requires_supervisor_on_retry` | boolean | no | Whether retry requires explicit supervisor approval. |

### 3.7 Canonical JSON example

```json
{
  "schema_version": "2.0",
  "request_id": "req_01JY8Q9F4N4R4D4V0K8Z7T6Y2P",
  "run_id": "run_01JY8Q9ENKQK9R9T8A1B2C3D4E",
  "mission_id": "mission_repo_inspection_2026_04_19",
  "session_id": "sess_c79b5e32d9a3",
  "execution_id": "exec_01JY8Q9G7L3N5D7P9Q1R2S3T4U",
  "task_type": "repo_inspection",
  "goal": "Inspect the target repository and produce the required supervised artifacts.",
  "instructions": [
    "Operate only within the provided workdir/worktree boundary.",
    "Produce all required artifacts at the exact requested paths.",
    "Return a contract-compliant result envelope."
  ],
  "constraints": {
    "network_access": false,
    "write_access": true,
    "max_steps": 20,
    "max_subprocess_depth": 1,
    "path_allowlist": [
      "/tmp/pi-worktrees/mission-123",
      "/tmp/pi-artifacts/mission-123"
    ],
    "path_denylist": [
      "/Users/jaywest/.ssh",
      "/Users/jaywest/.aws"
    ],
    "side_effect_class": "local_write",
    "requires_isolation": true
  },
  "allowed_tools": ["bash", "git", "python"],
  "disallowed_tools": ["browser", "external_messaging"],
  "workdir": "/tmp/pi-worktrees/mission-123",
  "repo": {
    "root": "/Users/jaywest/.hermes/hermes-agent",
    "vcs": "git",
    "remote": "origin",
    "commit_sha": "abc123def456",
    "worktree_path": "/tmp/pi-worktrees/mission-123"
  },
  "branch": "pi/mission-123",
  "timeout_seconds": 900,
  "budget": {
    "max_tokens": 60000,
    "max_cost_usd": 1.5,
    "max_tool_calls": 25,
    "max_runtime_seconds": 600
  },
  "artifacts_expected": [
    {
      "type": "summary",
      "role": "primary_result",
      "path": "/tmp/pi-artifacts/mission-123/summary.md",
      "required": true,
      "description": "Human-readable architecture summary"
    },
    {
      "type": "result",
      "role": "primary_result",
      "path": "/tmp/pi-artifacts/mission-123/result.json",
      "required": true,
      "description": "Structured mission result payload"
    },
    {
      "type": "manifest",
      "role": "primary_result",
      "path": "/tmp/pi-artifacts/mission-123/artifact-manifest.json",
      "required": true,
      "description": "Artifact manifest produced by Hermes"
    },
    {
      "type": "trace",
      "role": "supporting_log",
      "path": "/tmp/pi-artifacts/mission-123/trace.json",
      "required": true,
      "description": "Execution trace for auditing"
    }
  ],
  "approval_policy": {
    "mode": "on_dangerous_action",
    "allow_interrupt": true,
    "allow_cancel": true,
    "requires_supervisor_on_retry": true
  },
  "priority": "normal",
  "metadata": {
    "origin": "pi-bridge",
    "retry_count": 0,
    "requested_by": "pi-supervisor"
  }
}
```

---

## 4. Result envelope schema

This envelope is returned from **Hermes to Pi**.

### 4.1 Field definitions

| Field | Type | Required | Description |
|---|---|---:|---|
| `schema_version` | string | yes | Contract version. Must match or be compatible with request. |
| `request_id` | string | yes | Original request id. |
| `run_id` | string | yes | Original logical run id. |
| `mission_id` | string | yes | Original mission id. |
| `session_id` | string | yes | Pi-owned worker continuity session id. |
| `execution_id` | string | yes | Concrete execution attempt id. |
| `status` | string | yes | Final terminal status. Must be one of `succeeded`, `failed`, `cancelled`, `interrupted`, `timed_out`, `partial_completion`. |
| `started_at` | string (RFC3339) | yes | Execution start time. |
| `ended_at` | string (RFC3339) | yes | Execution end time. |
| `duration_ms` | integer | yes | End minus start in milliseconds. |
| `summary` | string | yes | Short human-readable completion summary. |
| `result` | object | no | Domain-specific structured result data. |
| `artifact_manifest` | array<object> | yes | Artifact manifest items. |
| `logs_ref` | object | no | Pointers to logs, traces, runtime directories, event logs. |
| `error` | object or null | yes | Structured error object when not successful. |
| `failure_class` | string or null | yes | Failure taxonomy classification. Null on clean success. |
| `next_action_needed` | string or null | yes | Supervisor-facing next step, if any. |
| `metrics` | object | no | Timing, token, tool-call, and budget metrics. |
| `metadata` | object | no | Additional structured metadata. |

### 4.2 Canonical JSON example

```json
{
  "schema_version": "2.0",
  "request_id": "req_01JY8Q9F4N4R4D4V0K8Z7T6Y2P",
  "run_id": "run_01JY8Q9ENKQK9R9T8A1B2C3D4E",
  "mission_id": "mission_repo_inspection_2026_04_19",
  "session_id": "sess_c79b5e32d9a3",
  "execution_id": "exec_01JY8Q9G7L3N5D7P9Q1R2S3T4U",
  "status": "succeeded",
  "started_at": "2026-04-19T20:00:00.000Z",
  "ended_at": "2026-04-19T20:00:45.235Z",
  "duration_ms": 45235,
  "summary": "Inspected the repository and produced all required artifacts.",
  "result": {
    "repo_summary": "Repository inspected successfully",
    "changed_files_detected": 0
  },
  "artifact_manifest": [
    {
      "artifact_id": "art_summary_01",
      "type": "summary",
      "role": "primary_result",
      "path": "/tmp/pi-artifacts/mission-123/summary.md",
      "sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "size_bytes": 4096,
      "mime_type": "text/markdown",
      "created_at": "2026-04-19T20:00:40.000Z",
      "produced_by": "hermes",
      "description": "Human-readable summary"
    }
  ],
  "logs_ref": {
    "event_log": "/tmp/pi-artifacts/mission-123/events.jsonl",
    "trace": "/tmp/pi-artifacts/mission-123/trace.json",
    "runtime_dir": "/tmp/pi-artifacts/mission-123/runtime"
  },
  "error": null,
  "failure_class": null,
  "next_action_needed": null,
  "metrics": {
    "tool_calls": 4,
    "artifacts_produced": 4,
    "estimated_tokens": 12500
  },
  "metadata": {
    "hermes_session_id": "20260419_124416_229fe4"
  }
}
```

---

## 5. Artifact manifest schema

Artifacts are first-class contract outputs. Hermes must describe produced artifacts explicitly, and Pi must validate them.

### 5.1 Field definitions

| Field | Type | Required | Description |
|---|---|---:|---|
| `artifact_id` | string | yes | Unique artifact identifier within the run. |
| `type` | string | yes | Contract artifact type. |
| `role` | string | yes | Semantic role, e.g. `primary_result`, `supporting_log`, `debug`, `evidence`. |
| `path` | string | yes | Absolute file path. |
| `sha256` | string | no | File digest in `sha256:<hex>` form. Recommended for all regular files. |
| `size_bytes` | integer | yes | Observed size in bytes. |
| `mime_type` | string | no | MIME type if known. |
| `created_at` | string (RFC3339) | yes | File creation timestamp if known, else write completion timestamp. |
| `produced_by` | string | yes | Usually `hermes`, subagent id, or tool name. |
| `description` | string | no | Human-readable summary of artifact purpose. |

### 5.2 Recommended artifact types

| Type | Meaning |
|---|---|
| `summary` | Human-readable mission summary |
| `result` | Structured result payload |
| `manifest` | Artifact manifest file |
| `trace` | Trace/debug timeline |
| `patch` | Diff or patch output |
| `log` | Plain log output |
| `test_result` | Test report or structured test result |
| `screenshot` | Image capture |
| `bundle` | Archived collection of outputs |

### 5.3 Pi validation expectations

Pi must validate artifact claims before treating a run as successful.

#### Required validations

1. **Existence check**
   - verify every manifest path exists on disk

2. **Required artifact check**
   - verify all `artifacts_expected.required == true` outputs were produced

3. **Hash check**
   - verify `sha256` when provided or when policy requires it

4. **Path check**
   - verify artifact path is within allowed output/artifact boundaries

5. **Type/role check**
   - verify artifact semantic purpose matches contract expectations

#### Manifest mismatch policy

If Hermes reports an artifact that does not exist, or fails to produce a required artifact:
- Pi must mark the run as failed or partial according to policy
- Pi must assign `failure_class = artifact_error`
- Pi must not silently accept the result envelope as successful

### 5.4 Canonical JSON example

```json
[
  {
    "artifact_id": "art_summary_01",
    "type": "summary",
    "role": "primary_result",
    "path": "/tmp/pi-artifacts/mission-123/summary.md",
    "sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "size_bytes": 4096,
    "mime_type": "text/markdown",
    "created_at": "2026-04-19T20:00:40.000Z",
    "produced_by": "hermes",
    "description": "Human-readable architecture summary"
  },
  {
    "artifact_id": "art_result_01",
    "type": "result",
    "role": "primary_result",
    "path": "/tmp/pi-artifacts/mission-123/result.json",
    "sha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "size_bytes": 1024,
    "mime_type": "application/json",
    "created_at": "2026-04-19T20:00:41.000Z",
    "produced_by": "hermes",
    "description": "Structured result payload"
  }
]
```

---

## 6. Run lifecycle state machine

The run lifecycle is explicit and finite.

### 6.1 States

| State | Meaning | Supervisor expectation |
|---|---|---|
| `queued` | Run created but not yet accepted by worker | Pi may reprioritize or cancel |
| `accepted` | Worker acknowledged the run envelope | Pi should expect start or failure soon |
| `starting` | Worker process/session is being prepared | Short-lived; no heavy work yet |
| `running` | Active execution is in progress | Expect progress or `task.heartbeat` |
| `waiting_approval` | Worker is paused pending supervisor/operator approval | Pi must either approve, deny, interrupt, or cancel |
| `blocked` | Worker cannot proceed without dependency/context/resource | Pi should inspect `next_action_needed` |
| `producing_artifacts` | Core execution done; worker is writing/validating outputs | Pi should expect artifacts or artifact events |
| `succeeded` | Run completed successfully with valid artifacts | Terminal state |
| `failed` | Run ended unsuccessfully | Terminal state |
| `cancelled` | Supervisor or operator cancelled the run | Terminal state |
| `interrupted` | Run was externally interrupted but not cleanly cancelled | Terminal state |
| `timed_out` | Hard timeout exceeded | Terminal state |

### 6.2 Allowed transitions

| From | Allowed to |
|---|---|
| `queued` | `accepted`, `cancelled` |
| `accepted` | `starting`, `cancelled`, `failed` |
| `starting` | `running`, `failed`, `cancelled`, `timed_out` |
| `running` | `waiting_approval`, `blocked`, `producing_artifacts`, `failed`, `interrupted`, `cancelled`, `timed_out` |
| `waiting_approval` | `running`, `cancelled`, `failed`, `timed_out` |
| `blocked` | `running`, `failed`, `cancelled`, `timed_out` |
| `producing_artifacts` | `succeeded`, `failed`, `cancelled`, `timed_out` |
| terminal states | none |

### 6.3 Invalid transition examples

| Invalid transition | Why invalid |
|---|---|
| `queued -> succeeded` | Run cannot succeed without acknowledgement and execution |
| `accepted -> producing_artifacts` | Startup and active execution were skipped |
| `succeeded -> running` | Terminal states are immutable |
| `failed -> succeeded` | Requires a new run or retry execution id |
| `waiting_approval -> succeeded` | Approval pause must resolve back into active execution or termination |

### 6.4 Supervisor expectations by state

- **queued**: run may still be modified or dropped
- **accepted**: bridge/worker ownership has begun
- **starting**: startup SLA should be short and measurable
- **running**: semantic heartbeats required
- **waiting_approval**: retry/timeout policy should tighten
- **blocked**: Pi should surface required next action explicitly
- **producing_artifacts**: Pi should expect artifact validation soon
- **terminal**: immutable, persist, auditable, replayable

---

## 7. Structured event schema

Every event emitted during execution must be structured and correlated.

### 7.1 Event fields

| Field | Type | Required | Description |
|---|---|---:|---|
| `event_id` | integer | yes | Monotonic per-run event id starting at 1. |
| `timestamp` | string (RFC3339) | yes | Event emission timestamp. |
| `schema_version` | string | yes | Contract version. |
| `event_type` | string | yes | Event name. See below. |
| `state` | string | yes | Current lifecycle state at event time. |
| `request_id` | string | yes | Request correlation id. |
| `run_id` | string | yes | Logical run id. |
| `mission_id` | string | yes | Parent mission id. |
| `session_id` | string | yes | Pi-owned worker continuity id. |
| `execution_id` | string | yes | Concrete execution attempt id. |
| `agent` | string | yes | Usually `pi` or `hermes`; may include subagent id. |
| `message` | string | no | Human-readable summary. |
| `artifact_refs` | array<string> | no | Referenced artifact ids. |
| `payload` | object | no | Event-specific structured payload. |
| `error_code` | string | no | Error code or failure code when relevant. |

### 7.2 Standard event types

| Event type | Typical state | Meaning |
|---|---|---|
| `run.accepted` | `accepted` | Hermes or bridge accepted the run envelope |
| `run.started` | `starting` or `running` | Execution actually began |
| `task.heartbeat` | `running` | Semantic health/progress heartbeat |
| `run.progress` | `running` | Meaningful mid-run progress update |
| `run.waiting_approval` | `waiting_approval` | Worker needs approval to continue |
| `run.blocked` | `blocked` | Worker cannot proceed |
| `artifact.produced` | `producing_artifacts` | Artifact written |
| `artifact.validated` | `producing_artifacts` | Artifact validated by supervisor or worker |
| `run.completed` | `succeeded` | Successful completion |
| `run.failed` | `failed` | Failed completion |
| `run.interrupted` | `interrupted` | Interrupted completion |
| `run.cancelled` | `cancelled` | Cancelled completion |
| `run.timed_out` | `timed_out` | Timeout completion |

### 7.3 Correlated IDs

Correlated ids are mandatory because they allow:
- joining result envelopes to event logs
- tracing mission lineage across retries
- debugging restarts and persistence reloads
- correlating artifacts, traces, and failures without log scraping

At minimum, every event must carry:
- `mission_id`
- `run_id`
- `request_id`
- `session_id`
- `execution_id`

### 7.4 Canonical JSON example

```json
{
  "event_id": 4,
  "timestamp": "2026-04-19T20:00:20.000Z",
  "schema_version": "2.0",
  "event_type": "run.progress",
  "state": "running",
  "request_id": "req_01JY8Q9F4N4R4D4V0K8Z7T6Y2P",
  "run_id": "run_01JY8Q9ENKQK9R9T8A1B2C3D4E",
  "mission_id": "mission_repo_inspection_2026_04_19",
  "session_id": "sess_c79b5e32d9a3",
  "execution_id": "exec_01JY8Q9G7L3N5D7P9Q1R2S3T4U",
  "agent": "hermes",
  "message": "Repository scan complete; producing summary artifact.",
  "artifact_refs": [],
  "payload": {
    "files_scanned": 138,
    "elapsed_ms": 20000
  },
  "error_code": null
}
```

---

## 8. Heartbeat semantics

Two distinct heartbeats exist in this system.

### 8.1 Transport heartbeat

Purpose:
- keep SSE or streaming connections visibly alive
- prove the transport/socket is still open

Characteristics:
- generated by transport/bridge layer
- not evidence of meaningful mission progress
- should not by itself reset stuck-run suspicion indefinitely

Example event name:
- `heartbeat` (transport-only, SSE keepalive)

### 8.2 Semantic run heartbeat

Purpose:
- prove the run is still supervised and meaningfully alive
- indicate the worker is still progressing or is intentionally waiting in a known state

Canonical event type:
- `task.heartbeat`

#### Required semantics
A semantic run heartbeat means one of the following is true:
1. Hermes is actively making progress
2. Hermes is still alive and holding a valid non-terminal state intentionally
3. Pi still has reason to keep supervising rather than declaring the run stuck

#### Emission guidance
- emit at least every **15 seconds** while `running`
- emit on long-running tool calls if no other progress events are produced
- include payload such as:
  - `elapsed_ms`
  - `current_step`
  - `recent_activity`
  - `waiting_reason` if applicable

#### Missing heartbeat interpretation
Pi should interpret missing semantic heartbeats as supervision risk, not immediate failure.

Suggested policy:
- no semantic heartbeat for **N=30s** while `running` → mark **suspected_stuck** internally
- no semantic heartbeat for **M=60s** while `running` and no artifact changes → classify as `stuck_run`
- Pi may then:
  - interrupt
  - cancel
  - retry once if policy allows
  - escalate for operator approval

Pi must not confuse an open SSE stream with a healthy run.

---

## 9. Failure taxonomy

Failures must be classified explicitly.

| Failure class | Meaning | Likely cause | Retry? | Pi action |
|---|---|---|---|---|
| `transport_error` | Request/stream/process transport failed | bridge socket issue, worker launch failure, local connectivity issue | yes, conservatively | retry once or restart bridge/session |
| `contract_error` | Envelope or result violated contract schema/semantics | malformed payload, missing required fields, unsupported schema version | no | fail hard, open bug/investigate runtime |
| `validation_error` | Pi-side validation failed | request invalid, path invalid, bad policy preflight | no | reject before execution or fail clearly |
| `policy_denied` | Supervisor policy forbids action | disallowed tool, repo, path, network, approval denial | no | surface denial, require operator change |
| `tool_error` | Tool execution failed | shell command/tool exception | maybe | retry only if known transient |
| `execution_error` | Hermes run failed during normal execution | reasoning failure, internal exception, bad runtime condition | maybe | retry only if non-deterministic/transient |
| `timeout` | Hard timeout reached | slow execution, loop, blocked tool | maybe once | interrupt/cancel, possibly retry with approval |
| `stuck_run` | No meaningful heartbeat/progress for too long | deadlock, wedged worker, hung subprocess | maybe once | interrupt, mark stuck, retry with policy |
| `artifact_error` | Required artifacts missing/mismatched | file not produced, hash mismatch, wrong path | usually no | fail hard or mark partial depending on policy |
| `partial_completion` | Some work succeeded but completion contract not fully met | partial artifact set, late failure during finalization | maybe with approval | preserve artifacts, surface next action |

---

## 10. Retry policy

Retry must be conservative and explicit.

### 10.1 Retryable vs non-retryable

| Failure class | Retryable | Guidance |
|---|---:|---|
| `transport_error` | yes | Retry once automatically if no external side effects were committed |
| `tool_error` | maybe | Retry only if classified transient and idempotent |
| `execution_error` | maybe | Retry once only if policy marks task as retry-safe |
| `timeout` | maybe | Retry once only with explicit supervisor policy or approval |
| `stuck_run` | maybe | Interrupt first, then retry once if safe |
| `partial_completion` | maybe | Prefer resume-from-artifacts later; otherwise supervisor approval |
| `contract_error` | no | Runtime bug or incompatible implementation |
| `validation_error` | no | Fix request or policy first |
| `policy_denied` | no | Requires policy/approval change |
| `artifact_error` | usually no | Retry only if cause is clearly transient and artifacts are idempotent |

### 10.2 Max retry guidance

Default:
- automatic retries: **max 1**
- total attempts per run_id: **max 2** without explicit supervisor override

### 10.3 Approval before retry

Supervisor approval is required before retry when:
- prior attempt had external side effects
- failure class is `timeout`, `stuck_run`, or `partial_completion`
- mission is marked high-risk or production-sensitive
- artifact mismatch could hide corruption

### 10.4 Retry recording

Retries must not overwrite prior attempts.

Rules:
- keep the same `run_id`
- generate a new `execution_id`
- increment `metadata.retry_count`
- persist prior envelopes, events, and artifacts
- link new attempt to previous attempt through metadata

---

## 11. Policy and supervision hooks

Pi must be able to enforce policy before and during execution.

### 11.1 Preflight validation

Before Hermes starts, Pi should validate:
- schema compatibility
- allowed/disallowed tool constraints
- workdir and repo boundaries
- timeout and budget sanity
- required artifacts are well-formed and writable
- mission type policy compatibility

### 11.2 Approval policy

`approval_policy` governs:
- whether writes require approval
- whether retries require approval
- whether interrupts/cancels are allowed
- whether dangerous actions pause into `waiting_approval`

### 11.3 Repo/tool constraints

Pi should reject or deny runs that:
- target unauthorized repos
- request disallowed tools
- attempt writes outside artifact/workdir boundaries
- violate mission-type rules

### 11.4 Time budget

Pi enforces:
- hard `timeout_seconds`
- optional soft budget from `budget.max_runtime_seconds`
- stuck-run detection based on semantic heartbeats

### 11.5 Artifact expectations

Pi should fail or downgrade completion when:
- required artifacts are missing
- manifest paths are invalid
- hashes mismatch when required
- artifact types/roles do not meet contract

### 11.6 Interrupt/cancel semantics

- **interrupt**: stop current execution as safely as possible; terminal state becomes `interrupted`
- **cancel**: supervisor-authoritative stop; terminal state becomes `cancelled`
- both actions must emit structured terminal events and persist final run state

---

## 12. Golden mission definition

The first required contract-test mission is:

> Inspect a repository in an isolated worktree, produce `summary.md`, `result.json`, `artifact-manifest.json`, and `trace.json`, then return a structured completion envelope.

### Required environment
- isolated worktree
- dedicated artifact directory
- no ambiguous output paths
- deterministic artifact names

### Required outputs
1. `summary.md`
2. `result.json`
3. `artifact-manifest.json`
4. `trace.json`
5. contract-compliant result envelope

### Why this mission comes first
This mission is ideal because it is:
- real enough to exercise the runtime
- low-risk and mostly local
- artifact-heavy
- easy to validate mechanically
- suitable for replay and golden fixtures

It exercises:
- request contract
- lifecycle state transitions
- artifact production
- artifact validation
- final envelope compliance
- event logging

---

## 13. Contract test plan

At minimum, five contract tests are required.

### 13.1 Successful execution

| Item | Definition |
|---|---|
| Setup | Valid request envelope targeting isolated worktree and writable artifact dir |
| Expected behavior | Hermes completes all required steps and produces all required artifacts |
| Expected final state | `succeeded` |
| Expected failure class | none |

### 13.2 Missing required artifact

| Item | Definition |
|---|---|
| Setup | Hermes omits one required artifact such as `trace.json` |
| Expected behavior | Pi validates manifest, detects missing artifact, rejects clean success |
| Expected final state | `failed` or `partial_completion` per policy |
| Expected failure class | `artifact_error` |

### 13.3 Invalid state transition

| Item | Definition |
|---|---|
| Setup | Inject or simulate illegal transition such as `accepted -> succeeded` |
| Expected behavior | Runtime rejects transition and records a contract violation |
| Expected final state | `failed` |
| Expected failure class | `contract_error` |

### 13.4 Heartbeat / stuck-run failure

| Item | Definition |
|---|---|
| Setup | Run enters `running` and stops emitting semantic heartbeats/progress beyond threshold |
| Expected behavior | Pi marks suspected stuck, escalates per policy, then terminates or fails run |
| Expected final state | `interrupted`, `cancelled`, or `failed` depending on policy |
| Expected failure class | `stuck_run` |

### 13.5 Malformed contract/result payload

| Item | Definition |
|---|---|
| Setup | Hermes returns malformed result envelope or wrong schema version |
| Expected behavior | Pi rejects payload at contract boundary |
| Expected final state | `failed` |
| Expected failure class | `contract_error` |

---

## 14. Implementation notes

### 14.1 Versioning expectations

- all envelopes and events must carry `schema_version`
- minor additive changes should preserve compatibility where possible
- breaking changes require version bump and compatibility review
- unsupported versions must fail closed

### 14.2 Backwards compatibility

- do not silently coerce incompatible envelopes
- if migration is needed, implement explicit migration code and tests
- bridge persistence must preserve original versioned records

### 14.3 Logging and trace hygiene

- logs must be structured and correlated
- avoid relying on human-formatted terminal output for core correctness
- redact secrets and sensitive paths where required
- keep event logs append-only for auditability

### 14.4 Isolated worktree recommendation

For code-affecting missions:
- provision one isolated worktree per mission/run
- keep artifacts outside the repo worktree when possible
- store explicit repo/worktree references in the envelope

### 14.5 Artifact directory conventions

Recommended per-run layout:

```text
<artifact_root>/
  summary.md
  result.json
  artifact-manifest.json
  trace.json
  events.jsonl
  runtime/
```

Rules:
- paths should be absolute in the contract
- file names should be deterministic for golden missions
- artifact manifest should describe all produced files, not just the required minimum

### 14.6 Auditability requirements

A reviewer must be able to reconstruct:
- what Pi asked Hermes to do
- what state transitions occurred
- what artifacts were produced
- whether artifacts were valid
- why the run succeeded or failed
- whether retries happened
- what supervisor decisions intervened

If that cannot be reconstructed from persisted contract artifacts, the runtime is not compliant.

---

## Appendix A: Recommended terminal status mapping

| Lifecycle terminal state | Result envelope `status` | Typical event |
|---|---|---|
| `succeeded` | `succeeded` | `run.completed` |
| `failed` | `failed` | `run.failed` |
| `cancelled` | `cancelled` | `run.cancelled` |
| `interrupted` | `interrupted` | `run.interrupted` |
| `timed_out` | `timed_out` | `run.timed_out` |
| policy-approved partial | `partial_completion` | `run.failed` or `run.completed` with next action |

---

## Appendix B: Immediate implementation sequence

This contract is intended to drive the next runtime-hardening sequence:

1. implement artifact manifest as first-class runtime output
2. implement structured event schema with correlated ids
3. implement lifecycle state machine and transition validation
4. implement semantic run heartbeat events and stuck-run detection
5. implement failure taxonomy and conservative retry rules
6. add contract tests around the golden mission

That sequence hardens the control plane before additional feature expansion.
