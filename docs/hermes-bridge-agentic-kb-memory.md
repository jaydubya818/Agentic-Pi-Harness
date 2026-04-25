# Hermes bridge + Agentic-KB memory integration

## Goal

Add the smallest safe adapter layer so Agentic Pi Harness can:
- talk to Hermes through the existing bridge boundary
- retrieve read-only Agentic-KB context as memory
- load scoped Pi agent context when available
- build a bounded context pack with source evidence
- report what bridge/memory context was used
- keep writeback disabled by default

## Repos and boundaries

- Agentic-Pi-Harness: execution harness and bridge client
- Hermes / MissionControl: unchanged for this PR
- Agentic-KB: unchanged for this PR

Rules:
- no cross-repo imports into Pi from Hermes or MissionControl
- no direct Agentic-KB library imports for phase 1
- use adapters, CLI calls, HTTP calls, and local read-only filesystem access
- memory is advisory context only and cannot override system or operator safety

## Discovery summary

Current Pi state:
- existing bridge server: `src/hermes/httpBridge.ts`
- existing bridge wrapper: `src/hermes/bridgeClient.ts`
- existing supervisor path: `src/orchestration/hermesSupervisor.ts`
- existing CLI surface: `src/cli/hermes-run.ts`, `src/cli/hermes-doctor.ts`

Current KB state:
- local repo path: `/Users/jaywest/Agentic-KB`
- CLI: `cli/kb.js`
- MCP server: `mcp/server.js`
- HTTP API: `/api/search`, `/api/query`, article routes
- worker contract currently recommended for Pi bootstrap: `gsd-executor`

Least invasive phase-1 path:
1. Keep Hermes communication on the existing bridge path.
2. Add a real `HermesBridgeClient` boundary around bridge HTTP calls and timeouts.
3. Add a `MemoryProvider` boundary in Pi.
4. Implement `AgenticKbMemoryProvider` with these access paths:
   - local filesystem search/read for deterministic read-only memory
   - local KB CLI for scoped agent context loading
   - optional HTTP search/read fallback when `KB_API_URL` is configured
   - optional CLI writeback only when explicitly enabled
5. Add `ContextPackBuilder` to combine task objective + KB search hits + agent context + bridge metadata into a bounded advisory context section.
6. Expose minimal CLI support through existing `pi-harness` commands.

## Proposed components

### 1. HermesBridgeClient

Purpose:
- health check bridge availability
- create sessions
- execute requests
- poll runs
- fetch events
- apply request timeouts
- fall back to embedded local bridge when external bridge URL is unavailable

Notes:
- preserve current bridge API shapes
- keep mockable via injected `fetch`

### 2. MemoryProvider interface

Methods:
- `healthCheck()`
- `search(query, options)`
- `get(slug)`
- `loadAgentContext(agentId, options)`
- `closeAgentTask(agentId, payload)`

Defaults:
- read-only
- disabled gracefully when KB path / API is unavailable

### 3. AgenticKbMemoryProvider

Read paths for phase 1:
- local wiki filesystem search/read
- local CLI parse for `kb agent context`
- optional HTTP search/read fallback

Write path for phase 1:
- none unless `writeEnabled=true`
- if enabled, use local CLI `kb agent close-task ...`
- no direct wiki file mutation in Pi harness

### 4. ContextPackBuilder

Responsibilities:
- combine task prompt + memory results + agent context + bridge metadata
- deduplicate repeated sources
- enforce character budget
- produce a memory evidence report with source slugs / paths / titles
- mark advisory context explicitly

Output contract:
- `taskPrompt`
- `memoryUsed`
- `agentContextLoaded`
- `sources[]`
- `fallbackReason`
- `memoryEvidenceSection`

### 5. Task execution integration

Phase-1 integration point:
- extend `runHermesSupervisorTask`
- optional config/env enables memory lookup before bridge execution
- built context pack is appended to the worker objective as an advisory section
- returned supervisor result includes a bridge/memory report

## Config

Add support for:
- `PI_HERMES_BRIDGE_URL`
- `PI_HERMES_BRIDGE_TIMEOUT_MS`
- `PI_AGENTIC_KB_PATH`
- `PI_AGENTIC_KB_ACCESS_MODE`
- `PI_AGENTIC_KB_MAX_RESULTS`
- `PI_AGENTIC_KB_CONTEXT_BUDGET_CHARS`
- `KB_API_URL`
- `PRIVATE_PIN`
- `ANTHROPIC_API_KEY`

Behavior:
- do not hardcode `/Users/jaywest/Agentic-KB` as runtime default; treat it as an example path only
- if KB path unset and API unavailable, memory is disabled gracefully
- if bridge URL unset, use embedded bridge path
- if external bridge is unavailable, optionally fall back to embedded bridge path

## CLI surface

Implemented in this pass:
- extend `pi-harness hermes-run` with `--use-agentic-kb`, `--agent-id`, `--memory-query`, `--kb-path`, `--kb-access-mode`, and `--bridge-timeout-ms`
- add `pi-harness memory search <query>`
- add `pi-harness memory read <slug>`
- add `pi-harness memory context <agent-id>`

That keeps the first integration pass small while still exposing both the main Hermes supervisor path and direct read-only memory inspection commands.

## Tests

Deterministic tests only:
- bridge client health / timeout / embedded fallback
- local KB path missing -> disabled gracefully
- local wiki fixture search/read
- CLI context parsing via mocked command runner
- context pack budget and dedupe
- supervisor result includes memory evidence report
- writeback disabled by default
- advisory context cannot override safety rules

## Known phase-1 limitations

- no live MCP integration inside Pi harness yet
- no full KB query synthesis in tests
- no MissionControl contract changes in this PR
- HTTP path will be read-only for phase 1
- agent context loading depends on local KB CLI when using the local repo path

## Why this is the right first PR

- keeps governance boundary in the bridge
- avoids direct repo coupling
- adds useful read-only memory immediately
- keeps tests local and deterministic
- leaves room for later MCP / MissionControl contract work without redoing the adapter shape
