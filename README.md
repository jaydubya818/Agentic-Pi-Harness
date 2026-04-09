# Agentic Pi Harness

Deterministic **Tier A** agent harness proof built on Pi’s TypeScript runtime patterns.

This repo currently ships the **canonical golden path only**:
- mock model only
- one real read tool: `read_file`
- one real mutating tool: `write_file`
- crash-safe provenance + checkpoint writes
- hash-chained replay tape
- effect log
- placeholder policy decisions
- thin CLIs for `run`, `verify`, `what-changed`, `inspect`, `replay`, and `doctor`

Deferred Tier B/C topics such as provider integration, hooks, compaction, concurrency, worktrees, rollback, and richer observability are intentionally out of scope for this proof.

> **Release note:** this release covers **Tier A only** — the canonical golden path and its deterministic proof artifacts. Tier B and other deferred features are intentionally not implemented in this release candidate.

[![CI](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml)

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
```

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
```

During development you can run the TypeScript entrypoint directly:

```bash
npm run dev -- run ./.pi-work ./.pi-out
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
