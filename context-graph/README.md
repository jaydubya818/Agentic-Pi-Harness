# Personal Context Graph — Pi / Hermes Integration

## What

A typed graph of personal context (career, projects, reading, relationships, therapy themes, meetings, founder network) that Hermes and Pi sub-agents will load at session start to ground their reasoning in real personal context — not flat markdown.

## Canonical schema

The **schema lives in Agentic-KB** at:

```
Agentic-KB/wiki/personal/context-graph/
├── README.md
├── schema.md         ← canonical entity types and field shapes
└── seed.example.json ← placeholder skeleton
```

This repo (Agentic-Pi-Harness) holds the **consumer-side integration** — the JSON file Pi/Hermes load at runtime + the (planned) loader module.

## What's in this directory

- `README.md` — this file
- `seed.example.json` — copy of the placeholder skeleton (kept in sync with Agentic-KB's version)
- `seed.json` — **gitignored**; populated locally with real personal data
- `hermes-integration.md` — how Hermes loads + exposes the graph to sub-agents

## Why duplicate seed.example.json here instead of symlinking Agentic-KB?

Pi / Hermes ship to environments that don't necessarily have the Agentic-KB checked out alongside. Co-locating the example schema in this repo keeps the runtime self-contained while the human-readable schema docs (rationale, counter-arguments) stay in Agentic-KB.

When schema.md changes in Agentic-KB, this file gets re-synced. A future `scripts/sync-context-graph-schema.mjs` will automate it; for v0 it's a manual copy.

## How Pi / Hermes will consume it (v0 plan, not yet implemented)

1. At session start, Hermes loads `context-graph/seed.json` (if present) or falls back to `seed.example.json`.
2. Builds an in-memory index by `id`.
3. Exposes `context.lookup({ type, query, limit })` and `context.get(id)` to sub-agents via the existing contract layer (`src/hermes/contractV2.ts`).
4. Sub-agents reference entities by id in their prompts; the loader resolves them.

See `hermes-integration.md` for the detailed wiring proposal — that document will become the spec for the v0 implementation PR.

## Source of inspiration

Garry Tan, *Meta-Meta-Prompting: The Secret to Making AI Agents Work* (2026-05-10):
https://x.com/garrytan/status/2053127519872614419

The "book that read me back" use case (Pema Chödrön reflection mirrored against personal history) only works because the model can query a rich, structured personal graph. Same idea, applied here to Hermes and Pi.

## Status

v0 — schema scaffold only. No loader code yet. Next PR adds the loader + a smoke test that loads `seed.example.json` and resolves a sample lookup.

## Cross-repo links

- Schema source of truth: `Agentic-KB/wiki/personal/context-graph/schema.md`
- Pi/Hermes contract: `PI_HERMES_CONTRACT_V2.md` (this repo)
- Hermes runtime: `src/hermes/`
