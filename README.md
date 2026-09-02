# Agentic Pi Harness

## Governed agent execution, not just agent invocation

Agentic Pi Harness is an engineering prototype for **controllable, inspectable agent execution**. It explores how to surround probabilistic workers with versioned contracts, policy boundaries, durable state, append-only traces, verification, and explicit promotion authority.

The current implementation centers on a hardened **Pi ↔ Hermes** bridge and a governed execution model for Pi-supervised worker runtimes.

[![CI](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml)

## Why this exists

A capable model plus tools is not enough to create a trustworthy autonomous engineering system.

Agent runtimes also need answers to questions such as:

- What exactly was the agent authorized to do?
- Which tools and knowledge sources were available?
- What state survives if the process fails?
- What changed on disk?
- Can execution be replayed or audited?
- Which outputs are merely candidate work versus canonical truth?
- Who has authority to promote an output downstream?

This harness treats those concerns as part of the runtime rather than leaving them to prompt instructions.

## Implemented capabilities

- Pi-supervised bounded worker execution
- hardened Pi ↔ Hermes bridge
- versioned execution contracts
- persistent run state
- immutable mission-request records
- structured lifecycle events
- preflight policy decisions and denial persistence
- KB / Wiki access-policy enforcement
- append-only execution traces
- hash-chained run tapes
- deterministic diff/effect inspection
- replay and verification paths
- promotion lineage into canonical knowledge
- bridge-only safety mode for governed execution

## Runtime model

```text
Human / Control Surface
        ↓
     Mission
        ↓
      Pi
 execution supervisor
        ↓
 governed bridge
        ↓
 Hermes / worker runtime
        ↓
 tools + bounded knowledge
        ↓
 structured effects + traces
        ↓
 verification / promotion decision
```

### Authority boundaries

**Hermes / operator-facing systems** provide mission routing, synthesis, and interaction.

**Pi** acts as execution-level supervisor/governor for bounded runtime lanes.

**Worker processes** execute within the contract they receive.

**The bridge** is the required policy boundary for governed execution.

The important design idea is separation of capability from authority: a worker may be technically capable of an action without being authorized to perform it.

## Knowledge governance

The harness can enforce different authority levels across local knowledge stores.

Supported policy targets include:

- `~/Agentic-KB` — governed operational memory / system of record
- `~/My LLM Wiki` — broader research, synthesis, and working knowledge

Workers can be granted bounded write zones while canonical knowledge paths remain protected. Promotion into canonical state is a distinct governed action rather than an implicit side effect of generation.

## Execution artifacts

A canonical run produces durable evidence such as:

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

These artifacts make the execution inspectable after the model process itself is gone.

## Quick start

Requirements:

- Node.js `>=20.11.0`
- npm

```bash
npm install
npm run build
node dist/cli/index.js run ./.pi-work ./.pi-out
```

Install notes:

- **Install scripts (npm 11.16+ / v12):** `node-pty` compiles a native addon in
  its install script and has no Linux prebuild. Recent npm blocks install
  scripts by default (`npm warn allow-scripts ... node-pty`), which leaves
  `node-pty` without its `pty.node` binary and the PTY transport fails at
  import time. Nothing on the tested path (`typecheck`, `test`, `lint`,
  `build`, `golden:verify`) needs the compiled pty, so a blocked script is
  fine for development; approve it (`npm approve-scripts node-pty`, or your
  npm version's equivalent) only when you need the PTY transport.
- **`NODE_ENV=production`:** npm treats it as `--omit=dev`, so `npm ci` in a
  shell that exports it installs the two runtime dependencies and none of the
  toolchain, and every script above then fails with a missing binary. Run
  `unset NODE_ENV` (or `NODE_ENV=development npm ci`) first.

Verify the resulting tape:

```bash
node dist/cli/index.js verify ./.pi-out/tapes/<sessionId>.jsonl
```

Inspect effects:

```bash
node dist/cli/index.js what-changed ./.pi-out/effects/<sessionId>.jsonl
```

Replay:

```bash
node dist/cli/index.js replay ./.pi-out/tapes/<sessionId>.jsonl
```

## Relationship to AI Software Factories

This repository focuses on the **execution/harness layer** of autonomous engineering.

[Mission Control](https://github.com/jaydubya818/MissionControl) operates at the higher control-plane layer: intent, WorkOrders, policy, verification, evidence, recovery, and publication decisions.

Agentic Pi Harness explores what the lower runtime needs to provide so a control plane can safely delegate bounded work to agents.

```text
Mission Control / Software Factory
             ↓
      execution contract
             ↓
      Agentic Pi Harness
             ↓
       worker runtime
             ↓
     effects + evidence
```

## Design principles

1. Agent capability does not imply agent authority.
2. Execution contracts should be versioned and inspectable.
3. Policy decisions should survive process failure.
4. Side effects should be attributable to the run that caused them.
5. Candidate knowledge and canonical knowledge are different states.
6. Deterministic verification should surround nondeterministic execution.
7. Durable traces are more useful than trusting an agent's summary of what it did.

## Key documentation

- [`PI_HERMES_CONTRACT_V2.md`](PI_HERMES_CONTRACT_V2.md)
- [`KB_ACCESS_POLICY_V1.md`](KB_ACCESS_POLICY_V1.md)
- [`GOVERNED_EXECUTION_MODEL_V1.md`](GOVERNED_EXECUTION_MODEL_V1.md)
- [`docs/HERMES-ADAPTER.md`](docs/HERMES-ADAPTER.md)
- [`docs/WORKDAY-FACTORY-RUNTIME-ROLE.md`](docs/WORKDAY-FACTORY-RUNTIME-ROLE.md)

## Status

Active engineering prototype. The repository has evolved from a deterministic Tier-A harness proof into a reusable governed-execution model. It is intentionally narrower than a complete software-factory control plane: the focus is execution contracts, policy, traces, effects, replay, and promotion boundaries.
