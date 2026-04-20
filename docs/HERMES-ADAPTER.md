# HermesAdapter

`HermesAdapter` lets the Pi harness supervise a local Hermes CLI process as an external worker.

Default discovery conventions:
- Hermes binary: `~/.local/bin/hermes`
- Hermes repo: `~/.hermes/hermes-agent`

So:
- use the **binary path** when Pi should launch Hermes
- use the **repo path** when Pi should inspect or work inside the Hermes codebase

This integration deliberately uses **contracts, not imports**:
- Pi does **not** import Hermes Python internals
- Pi launches Hermes through the CLI
- Pi owns session ids, request ids, timeout enforcement, interrupt/cancel, and result collection
- Hermes owns reasoning, tool use, and any artifacts it writes during the task

## Current transport model

The implementation is **CLI-first**:
- preferred transport: **PTY**
- PTY backend order:
  1. `script`-backed PTY wrapper on systems where it is available
  2. `node-pty`
- fallback transport: standard subprocess pipes
- execution mode: `hermes chat -q ... -Q`
- session continuity: Hermes `--resume <session_id>` after the first completed task

On this machine, the working PTY path is the `script`-backed PTY wrapper. That gives Pi a real PTY transport even though `node-pty` itself currently fails here with `posix_spawnp failed`.

## Request contract

```json
{
  "request_id": "req_123",
  "session_id": "sess_123",
  "objective": "Review this repo and propose fixes",
  "workdir": "/absolute/path/to/repo",
  "allowed_tools": ["bash", "git", "python"],
  "allowed_actions": ["read", "write", "patch", "test"],
  "timeout_seconds": 900,
  "output_dir": "/tmp/pi-hermes-artifacts/req_123",
  "metadata": {
    "mission_id": "mission_1",
    "run_id": "run_1",
    "step_id": "step_1"
  }
}
```

## Result contract

```json
{
  "execution_id": "exec_456",
  "status": "completed",
  "summary": "Found 3 issues and prepared patch",
  "artifacts": [
    { "type": "report", "path": "/tmp/.../report.md" },
    { "type": "patch", "path": "/tmp/.../fix.patch" }
  ],
  "error": null
}
```

## Event model

Events are streamed as JSON-shaped records:
- `task.started`
- `task.output`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.interrupted`

## How structured results work

Hermes does not currently expose a native machine-readable task API through the CLI.

So the adapter wraps the prompt with a small contract asking Hermes to end with a marker block:

```text
<<PI_TASK_RESULT_JSON
{"summary":"short summary","artifacts":[...],"error":null}
PI_TASK_RESULT_JSON>>
```

The adapter parses that block if present.
If Hermes does not emit it, the adapter falls back to:
- plain final response text as the summary
- artifact discovery by scanning `output_dir` (excluding `.pi-hermes/` runtime files)

## Runtime files

For each request, the adapter writes runtime metadata under:

```text
<output_dir>/.pi-hermes/
  request.json
  result.json
  events.jsonl
  hermes.raw.log
```

Session metadata is also written under the adapter state root:

```text
/tmp/pi-hermes-adapter/<session_id>/session.json
```

## Demo

Run the demo against your local Hermes install:

```bash
npm run hermes:demo -- \
  --workdir "$PWD" \
  --output-dir "$PWD/.pi-hermes-demo" \
  --objective "Review this repo, write a short report to the output dir, and summarize your findings."
```

Or through the harness CLI:

```bash
npm run dev -- hermes-demo --workdir "$PWD"
```

## Real Hermes smoke test

This runs two supervised Hermes tasks in the same Pi session and verifies that Pi captures a reusable Hermes session id between runs.

```bash
npm run hermes:smoke -- --workdir "$PWD"
```

It writes artifacts under `.pi-hermes-smoke/` and prints:
- Pi session metadata
- captured Hermes session id
- first task result
- second task result

## Higher-level Pi orchestration path

A harness-native orchestration wrapper now exists:

```bash
npm run hermes:run -- --workdir "$PWD" --out-root "$PWD/.pi-hermes-out"
```

This path:
- creates a Pi supervisor session directory
- writes provenance
- stores request/result/event artifacts under the harness out root
- runs Hermes through `HermesAdapter`
- returns a single structured supervisor result

## Local HTTP bridge skeleton

A working local bridge is also available:

```bash
npm run hermes:bridge -- --host 127.0.0.1 --port 8787 --auth-token "$PI_HERMES_BRIDGE_TOKEN"
```

Bridge state is persistent by default under:

```bash
~/.pi/hermes-bridge-state
```

Override with `--state-root <path>` if you want a different durable store root.

If you omit `--auth-token`, the bridge stays open on the bound interface. Recommended local-safe default:

```bash
export PI_HERMES_BRIDGE_TOKEN="replace-me"
npm run hermes:bridge -- --host 127.0.0.1 --port 8787
```

Endpoints:
- `POST /sessions`
- `POST /execute`
- `POST /interrupt`
- `POST /cancel`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /healthz`
- `GET /meta`

## Bridge API normalization

`GET /runs/:id` now returns a normalized bridge view for both legacy and Contract V2 runs.

Shared top-level fields kept for compatibility:
- `execution_id`
- `request_id`
- `session_id`
- `status`
- `state`
- `result`
- `error`
- `failure_class`
- `event_count`

Additional normalized fields:
- `api_version`: `v1-compat` or `v2`
- `run_kind`: `legacy` or `contract_v2`
- `contract_version`: `2.0` for Contract V2 runs
- `lifecycle`: `{ state, bridge_status, terminal, failure_class }`
- `accepted`: original accepted envelope
- `task_envelope`: original Contract V2 task envelope when present
- `result_envelope`: Contract V2 result envelope when present
- `worker_result`: raw Hermes adapter result
- `events_format`: `legacy` or `structured_v2`
- `links`: event and stream URLs

For older callers that want the previous small response shape, use:

```text
GET /runs/:id?view=raw
```

`GET /runs/:id/events` now returns a normalized event container:

```json
{
  "api_version": "v2",
  "run_kind": "contract_v2",
  "contract_version": "2.0",
  "execution_id": "exec_123",
  "request_id": "req_123",
  "session_id": "sess_123",
  "event_format": "structured_v2",
  "count": 6,
  "items": [ ... ]
}
```

Compatibility escape hatch:

```text
GET /runs/:id/events?view=raw
```

For Contract V2 runs, the normalized events response exposes only structured V2 events. Raw worker events remain available through `?view=raw` for debugging and bridge archaeology.

Auth behavior:
- `GET /healthz` stays open for local liveness checks
- all other endpoints require `Authorization: Bearer <token>` when bridge auth is configured
- configure via `--auth-token <token>` or `PI_HERMES_BRIDGE_TOKEN`

Hermes doctor:

```bash
npm run hermes:doctor -- --url http://127.0.0.1:8787
```

It validates:
- bridge reachability
- auth enforcement
- authorized `/meta`
- detected Hermes binary and repo paths
- bridge session creation
- one real `/execute` smoke test
- observed transport mode and PTY backend

Persistent bridge state currently includes:
- durable session store on disk
- durable run store on disk
- append-only `events.jsonl` per run
- restart-safe reload on bridge boot
- normalized `GET /runs/:id` survives restart
- normalized `GET /runs/:id/events` survives restart

This keeps the adapter contract stable while giving Pi a service boundary for future orchestration.

## Notes and limitations

### Enforced by Pi
- process spawn/supervision
- timeout handling
- interrupt/cancel/kill
- workdir launch boundary
- request/result logging
- session continuity tracking

### Advisory in v1
These fields are passed to Hermes in the prompt and env, but are **not hard-enforced by Hermes CLI itself** in this first adapter:
- `allowed_tools`
- `allowed_actions`

If you need hard enforcement, the next step is an HTTP bridge or a Hermes-side policy wrapper.

### CLI mode used
The adapter uses Hermes single-query mode (`hermes chat -q -Q`) because it is much less brittle than scraping the full interactive TUI.
That still fits the supervised worker-process model:
- Pi spawns Hermes
- Pi observes output
- Pi interrupts/cancels Hermes
- Pi resumes the Hermes session on later tasks

## Evolution path from here

Current state:
- PTY transport works on this machine via `script`
- the harness has a higher-level supervisor path
- the local HTTP bridge skeleton is implemented and working

Recommended next step:
1. add persistent bridge run storage
2. add SSE or NDJSON live event streaming for `/runs/:id/events`
3. harden policy enforcement around `allowed_tools` / `allowed_actions`
4. move more orchestration callers to the HTTP bridge while keeping `HermesAdapter` as the stable contract boundary
