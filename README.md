# Agentic Pi Harness

Governed execution harness for **Pi-supervised worker runtimes**, with a hardened **Pi ↔ Hermes** bridge, versioned contracts, structured run state, KB/Wiki policy enforcement, and contract-tested execution.

[![CI](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml)

---

## What this repo is now

This repo started as a deterministic Tier A harness proof. It now also contains a **governed execution model** for supervised worker runtimes.

Current implemented direction:

- **Pi** as supervisor / orchestrator
- **Hermes** as a governed worker
- **Bridge-routed governed execution**
- **Versioned execution contract**
- **Persistent run state**
- **Structured events**
- **Preflight denial persistence**
- **KB / Wiki access policy enforcement**
- **Append-only traces**
- **Immutable mission request records**
- **Promotion lineage into canonical knowledge**
- **Bridge-only safety mode for governed execution**

This repo is no longer just golden-path replay. It now contains the beginnings of a reusable control plane for governed agent execution.

Relevant docs:
- [`PI_HERMES_CONTRACT_V2.md`](PI_HERMES_CONTRACT_V2.md)
- [`KB_ACCESS_POLICY_V1.md`](KB_ACCESS_POLICY_V1.md)
- [`GOVERNED_EXECUTION_MODEL_V1.md`](GOVERNED_EXECUTION_MODEL_V1.md)
- [`docs/HERMES-ADAPTER.md`](docs/HERMES-ADAPTER.md)

---

## Core model

### Roles

- **Pi**: supervisor, governor, promoter of canonical truth
- **Hermes**: governed worker
- **Bridge**: the required control-plane boundary for governed execution

### Knowledge model

Two local knowledge repositories are supported by policy and runtime enforcement:

- `~/Agentic-KB` — governed operational memory / system of record
- `~/My LLM Wiki` — broader research, synthesis, and working knowledge

### Write model

Pi may govern and promote canonical knowledge.

Hermes is intentionally constrained to bounded non-canonical write zones such as:

- `~/My LLM Wiki/**`
- `~/Agentic-KB/queues/discovery/**`
- `~/Agentic-KB/handoffs/inbound/**`
- `~/Agentic-KB/missions/**/outputs/**`
- `~/Agentic-KB/missions/**/traces/**`

Hermes is blocked from canonical KB paths such as:

- `~/Agentic-KB/contracts/**`
- `~/Agentic-KB/standards/**`
- `~/Agentic-KB/knowledge/**`
- `~/Agentic-KB/staging/normalized/**`
- `~/Agentic-KB/supervision/**`

---

## Claude Code concise mode

This repo now ships a repo-local Claude Code default for concise engineering output:

- Caveman is installed for Claude Code via the official plugin marketplace
- repo-local default mode is **Caveman lite** via `.claude/settings.json`
- repo-local usage guidance lives in [`CLAUDE.md`](CLAUDE.md)

Intended effect:
- concise normal responses
- concise code review comments
- concise commit message suggestions
- compressed wording without dropping technical substance

To change the default level later, update:
- `.claude/settings.json` → `env.CAVEMAN_DEFAULT_MODE`

Current default:
- `lite`

---

## Prerequisites

- Node `>=20.11.0`
- npm

Optional check:

```bash
npm run doctor
```

---

## Quickstart

```bash
npm install
npm run build
```

Run the canonical golden path:

```bash
node dist/cli/index.js run ./.pi-work ./.pi-out
```

The command prints a session id like:

```text
session golden-abc12345-deadbeef
```

Artifacts land under:

```text
.pi-out/
  tapes/<sessionId>.jsonl
  effects/<sessionId>.jsonl
  sessions/<sessionId>/
    checkpoint.json
    metrics.json
    policy.jsonl
    provenance.json
```

Verify the tape:

```bash
node dist/cli/index.js verify ./.pi-out/tapes/<sessionId>.jsonl
```

Inspect file changes:

```bash
node dist/cli/index.js what-changed ./.pi-out/effects/<sessionId>.jsonl
```

Inspect placeholder policy decisions:

```bash
node dist/cli/index.js inspect ./.pi-out/sessions/<sessionId>/policy.jsonl
```

Replay the tape:

```bash
node dist/cli/index.js replay ./.pi-out/tapes/<sessionId>.jsonl
```

---

## Golden-path walkthrough

The canonical run edits `tests/math.test.ts` from a failing assertion to a passing one.

### 1. Run the harness

```bash
node dist/cli/index.js run ./.pi-work ./.pi-out
```

Expected target file after the run:

```text
.pi-work/tests/math.test.ts
```

Expected final contents:

```ts
test('adds', () => { expect(1 + 1).toBe(2); });
```

### 2. Verify the tape

```bash
node dist/cli/index.js verify ./.pi-out/tapes/<sessionId>.jsonl
```

Expected shape:
- 1 header record
- 8 event records
- valid hash chain

### 3. Show the diff

```bash
node dist/cli/index.js what-changed ./.pi-out/effects/<sessionId>.jsonl
```

Expected output includes:
- `# write_file (t2)`
- `tests/math.test.ts`
- the `3 -> 2` assertion change

### 4. Inspect policy output

```bash
node dist/cli/index.js inspect ./.pi-out/sessions/<sessionId>/policy.jsonl
```

Expected output includes two placeholder approvals:
- `t1 approve provenance=placeholder`
- `t2 approve provenance=placeholder`

### 5. Replay the tape

```bash
node dist/cli/index.js replay ./.pi-out/tapes/<sessionId>.jsonl
```

Expected output prints the canonical sequence:
- `message_start`
- `text_delta`
- `tool_use read_file`
- `tool_result`
- `text_delta`
- `tool_use write_file`
- `tool_result`
- `message_stop`

---

## Trace output

A lightweight JSONL trace is available for debugging the Tier A loop.

Write trace output to a specific path:

```bash
node dist/cli/index.js run ./.pi-work ./.pi-out --trace=./trace.jsonl
```

Or use the default trace sink:

```bash
node dist/cli/index.js run ./.pi-work ./.pi-out --trace
```

Default path:

```text
~/.pi/traces/latest.jsonl
```

Each line contains:
- `at`
- `sessionId`
- `event`

This trace is supplemental debug output only; the replay tape remains the source of truth.

---

## Committed golden artifacts

The repo includes one committed canonical artifact set:

```text
goldens/canonical/
  tape.jsonl
  effects.jsonl
  policy.jsonl
```

Useful commands:

```bash
npm run golden:verify
npm run golden:replay
npm run bench
```

`npm test` covers the deterministic unit/fuzz/chaos suite. The hash-chain microbench is opt-in via `npm run bench` because its latency ceiling is environment-sensitive.

The CI workflow also runs the golden path and compares the produced artifacts against these committed golden files.

---

## Pre-commit guard

A local Husky pre-commit guard runs:

```bash
node scripts/check-schema-drift.mjs
```

If files under `src/schemas/` change, `docs/SCHEMAS.md` must be staged in the same commit.

---

## Command reference

```text
pi-harness doctor
pi-harness run [workdir] [outRoot] [--trace|--trace=<path>]
pi-harness verify <tape.jsonl>
pi-harness what-changed <effects.jsonl>
pi-harness inspect <policy.jsonl>
pi-harness replay <tape.jsonl>
pi-harness hermes-demo [--workdir <path>] [--output-dir <path>] [--objective <text>]
pi-harness hermes-smoke [--workdir <path>] [--output-dir <path>]
pi-harness hermes-run [--workdir <path>] [--out-root <path>] [--objective <text>]
pi-harness hermes-bridge [--host <host>] [--port <port>] [--auth-token <token>] [--state-root <path>]
pi-harness hermes-doctor [--url <url>] [--token-file <path>] [--workdir <path>]
pi-harness acceptance-hermes [--url <url>] [--token-file <path>] [--workdir <path>]
pi-harness acceptance-pi [workdir] [outRoot] [--trace=<path>]
kb session acceptance hermes [--url <url>] [--token-file <path>] [--workdir <path>]
kb session acceptance pi [workdir] [outRoot] [--trace=<path>]

npm run lint
npm run typecheck
npm test
npm run bench
```

During development you can run the TypeScript entrypoint directly:

```bash
npm run dev -- run ./.pi-work ./.pi-out
```

Hermes demo:

```bash
npm run hermes:demo -- --workdir "$PWD"
```

Hermes two-step smoke test:

```bash
npm run hermes:smoke -- --workdir "$PWD"
```

Higher-level Pi orchestration path:

```bash
npm run hermes:run -- --workdir "$PWD" --out-root "$PWD/.pi-hermes-out"
```

Local HTTP bridge:

```bash
npm run hermes:bridge -- --host 127.0.0.1 --port 8787 --auth-token "$PI_HERMES_BRIDGE_TOKEN"
```

Bridge state persists by default under:

```bash
~/.pi/hermes-bridge-state
```

Override with `--state-root <path>` if needed.

Hermes doctor:

```bash
npm run hermes:doctor -- --url http://127.0.0.1:8787
```

Hermes acceptance helper (self-contained by default — it starts a temporary local bridge and token automatically):

```bash
npm run acceptance:hermes
# or
kb session acceptance hermes
```

To target an already-running external bridge instead:

```bash
npm run acceptance:hermes -- --url http://127.0.0.1:8787
# or
kb session acceptance hermes --url http://127.0.0.1:8787
```

Pi acceptance helper:

```bash
npm run acceptance:pi
# or
kb session acceptance pi
```

When you want Pi to inspect Hermes itself, point `--workdir` at:

```bash
~/.hermes/hermes-agent
```

When you want Pi to launch Hermes explicitly, point `--command` at:

```bash
~/.local/bin/hermes
```

---

## Determinism contract in this Tier A proof

- **Level A:** canonical event stream matches after normalization of nondeterministic tape fields
- **Level B:** effect log matches for the single canonical write
- **Level C:** placeholder policy decisions match for the two canonical tool calls

See also:
- [`docs/GOLDEN-PATH.md`](docs/GOLDEN-PATH.md)
- [`docs/REPLAY-MODEL.md`](docs/REPLAY-MODEL.md)
- [`docs/SCHEMAS.md`](docs/SCHEMAS.md)
- [`docs/SOFIE-CONTRACT.md`](docs/SOFIE-CONTRACT.md)
