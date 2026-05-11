# Hermes Integration — Personal Context Graph

> v0 wiring spec. Not yet implemented; this document is the agreement we land
> before opening the implementation PR.

## Goal

Make the personal context graph (career, projects, reading, relationships,
therapy themes, meetings, founder network) addressable from any sub-agent
spawned by Hermes, without each sub-agent re-reading the underlying JSON or
the wiki.

## Proposed surface

### Loader (`src/context-graph/loader.ts`, new file)

```ts
export interface ContextGraphEntity {
  id: string;
  type: 'career' | 'projects' | 'reading' | 'relationships'
      | 'therapy_themes' | 'meetings' | 'founder_network';
  updated_at: string;        // ISO-8601 date
  confidence: 'high' | 'medium' | 'low';
  [key: string]: unknown;    // type-specific fields per schema.md
}

export interface ContextGraph {
  byId: Map<string, ContextGraphEntity>;
  byType: Map<string, ContextGraphEntity[]>;
  meta: { schema_version: string; generated: string };
}

export function loadContextGraph(opts?: {
  path?: string;             // default: context-graph/seed.json or seed.example.json
  strict?: boolean;          // throw on schema violation; default false
}): Promise<ContextGraph>;
```

Behavior:
1. If `seed.json` exists → load it.
2. Else if `seed.example.json` exists → load it and log a warning.
3. Else return an empty graph.
4. Validate ids unique, cross-references resolve. In `strict` mode, throw;
   otherwise log + drop the bad entry.

### Hermes contract additions (`src/hermes/contractV2.ts`)

```ts
context: {
  /** Lookup entities by type + freeform query (substring match on name/title). */
  lookup(args: {
    type?: ContextGraphEntity['type'];
    query?: string;
    limit?: number;
  }): Promise<ContextGraphEntity[]>;

  /** Get a single entity by id. */
  get(id: string): Promise<ContextGraphEntity | null>;

  /** List all entities of a given type (no filtering). */
  list(type: ContextGraphEntity['type']): Promise<ContextGraphEntity[]>;
}
```

### Boot order

1. `src/index.ts` calls `loadContextGraph()` during Hermes startup.
2. The graph instance is passed into the contract layer, which exposes
   `context.{lookup,get,list}` to sub-agents.
3. Sub-agents may reference entities in prompts by id (e.g.
   `{{context.get('project-sellerfi')}}`); template resolution happens
   in the existing tool-call layer.

## What's deliberately out of scope for v0

- **Mutation** — sub-agents can read but not write. Editing the graph is a
  human action (edit `seed.json`, commit not allowed — it's gitignored, so
  changes stay local).
- **Embeddings / semantic search** — `lookup` is substring match only. If
  this turns out to be insufficient in practice, add an optional embedding
  index in v1.
- **Cross-repo sync** — Agentic-KB and Agentic-Pi-Harness each have their
  own `seed.example.json`. A `scripts/sync-context-graph-schema.mjs` will
  enforce parity later; for v0 it's a manual copy.

## Test plan for the v0 implementation PR

- Unit: loader handles missing file, malformed JSON, duplicate ids,
  unresolved cross-references.
- Unit: `lookup` substring-matches across name/title fields, respects
  `limit`.
- Integration: spin up Hermes with `seed.example.json`, confirm a
  sub-agent's `context.get('project-placeholder-1')` returns the
  placeholder entity.

## Risk

Low. The loader is pure (file → in-memory structure). The contract addition
is additive — no existing call site changes shape. Worst case if the loader
errors: Hermes logs a warning and proceeds with an empty graph, behaving
exactly as today.

## Open questions

1. Should `seed.example.json` ship as a fallback in production, or should
   missing `seed.json` simply mean an empty graph? (Current proposal:
   fallback in dev, empty in prod, gated by `NODE_ENV`.)
2. Cache invalidation — if Jay edits `seed.json` mid-session, do we hot-
   reload or require restart? v0: restart-only.
3. Where do the `linked_*` cross-references resolve? Eagerly at load (one
   pass) or lazily at `.lookup()` time? v0: eager validation, lazy
   resolution (return id strings; caller calls `.get()` to follow).
