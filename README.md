# Agentic Pi Harness

A production-grade agent runtime built on the [pi.dev](https://github.com/mariozechner/pi) TypeScript harness. Deterministic replay, hash-chained audit tapes, prompt-injection containment, policy engine with rule inheritance, structured observability, and crash-safe checkpoints.

**Current version:** v0.3.0 — 28 test files / 84 tests, tsc clean, CI green.

[![CI](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jaydubya818/Agentic-Pi-Harness/actions/workflows/ci.yml)

---

## Quick start

```bash
npm install
npm run build

# Diagnostics
node dist/cli/index.js doctor

# Golden-path run (mock model, no API key needed)
node dist/cli/index.js run --out ./.pi-out --workdir ./.pi-work

# Verify a tape's hash chain
node dist/cli/index.js verify ./.pi-out/tapes/<sessionId>.jsonl

# Inspect effect diffs from a run
node dist/cli/index.js what-changed ./.pi-out/effects/<sessionId>.jsonl

# Inspect policy decisions
node dist/cli/index.js inspect ./.pi-out/sessions/<sessionId>/policy.jsonl

# Replay a tape and detect drift
node dist/cli/index.js replay ./.pi-out/tapes/<sessionId>.jsonl
```

### Using a real model (pi.dev / Anthropic)

```bash
export PI_HARNESS_PROVIDER=anthropic
export PI_HARNESS_MODEL=claude-sonnet-4-6
export PI_HARNESS_API_KEY=sk-ant-...
node dist/cli/index.js run --out ./.pi-out --workdir ./.pi-work
```

`createDefaultModelClient()` checks these env vars and swaps in `PiDevProvider` automatically. Without them it falls back to the scripted `MockModelClient` — no API key needed for tests or CI.

---

## Architecture

The harness is structured in three tiers, each building on the last.

```
┌─────────────────────────────────────────────┐
│  Tier C  observability + semantic drift      │  v0.2–v0.3
│  OTel meter · pino/JSON logger · cost track  │
│  semantic decision hash · shell hooks        │
├─────────────────────────────────────────────┤
│  Tier B  supervised runtime                  │  v0.1
│  PolicyEngine · hooks · retry · compaction   │
│  concurrency · worktree · Level B/C replay   │
├─────────────────────────────────────────────┤
│  Tier A  runtime foundation                  │  v0.1
│  schemas · loop · effects · tapes · CLIs     │
└─────────────────────────────────────────────┘
```

Full 5+1 layer diagram and invariants: [`docs/ARCHITECTURE-RUNTIME.md`](docs/ARCHITECTURE-RUNTIME.md)

---

## Feature reference

### Tier A — Runtime foundation

| Feature | Source |
|---|---|
| Zod schemas with `schemaVersion` for every persisted type | `src/schemas/` |
| Async-generator query loop with per-chunk retry + `EffectScope` | `src/loop/query.ts` |
| Mock model adapter for deterministic runs | `src/adapter/pi-adapter.ts` |
| Real pi.dev provider seam with lazy import + chunk normalization | `src/adapter/piDevProvider.ts` |
| **Default client factory** — env-based mock-vs-real switch | `src/adapter/defaultClient.ts` |
| Effect recorder: pre/post hash · LCS unified diff · rollback confidence | `src/effect/recorder.ts` |
| Hash-chained replay tape (`prevHash`/`recordHash` + framed canon.) | `src/replay/recorder.ts` |
| Prompt-injection containment (`<tool_output trusted="false">` + sanitization) | `src/loop/promptAssembly.ts` |
| Crash-safe writes (write-rename + fsync) | `src/session/provenance.ts` |
| CLIs: `doctor` · `run` · `verify` · `replay` · `what-changed` · `inspect` | `src/cli/` |

### Tier B — Supervised runtime

| Feature | Source |
|---|---|
| `PolicyEngine` — rule-based allow/deny with full provenance | `src/policy/engine.ts` |
| **Rule inheritance** (`extends:`) with cycle detection (`E_POLICY_CYCLE`) | `src/policy/engine.ts` |
| HMAC-SHA256 signed policy + strict worker-mode verification | `src/policy/signed.ts` |
| In-process hook dispatcher — per-hook timeouts + canonical audit digests | `src/hooks/dispatcher.ts` |
| **Shell-contract hook executor** — stdin/stdout JSON, SIGKILL timeout | `src/hooks/shellHook.ts` |
| Retry state machine — transient / rate-limit / context-overflow / fatal | `src/retry/stateMachine.ts` |
| 4-strategy context compaction with `CompactionRecord` audit trail | `src/context/compaction.ts` |
| Concurrency classifier — readonly parallel · serial per-name · exclusive drain | `src/tools/concurrency.ts` |
| Sub-agent git worktree isolation with escape guard | `src/subagents/worktree.ts` |
| Level B (effect diff) + Level C (decision diff) replay drift detection | `src/replay/levelB.ts`, `src/replay/levelC.ts` |

### Tier C — Observability + semantic determinism

| Feature | Source |
|---|---|
| `CountersSink` interface + `FanOutCounters` for multi-sink delegation | `src/metrics/counter.ts` |
| OpenTelemetry meter swap-in (`createOtelCounters`) — lazy peer dep | `src/metrics/otel.ts` |
| **Cost tracking** — `CostTracker` / `CostRecord` / `CostTable`; `LoopResult.cost` | `src/metrics/cost.ts` |
| `Logger` interface — `NoopLogger` · `JsonLogger` · `createPinoLogger` | `src/obs/logger.ts` |
| Semantic decision hash (`sha256-semantic:` over `{result, toolName, effectClass}`) | `src/policy/semanticHash.ts` |
| `compare-decisions.mjs --semantic` — rule-rename-invariant drift check | `scripts/compare-decisions.mjs` |
| `npm audit --audit-level=high` gate in CI | `.github/workflows/ci.yml` |

---

## Policy engine

Rules are evaluated in order; first match wins. Every decision records full provenance.

```json
{
  "schemaVersion": 1,
  "default": "approve",
  "rules": [
    { "id": "deny-writes",     "match": { "tool": "write_*" }, "action": "deny" },
    { "id": "deny-writes-src", "extends": "deny-writes", "match": { "pathPrefix": "/src/" } },
    { "id": "allow-reads",     "match": { "tool": "read_*",  "mode": "assist" }, "action": "approve" }
  ]
}
```

`extends:` lets a child rule inherit its parent's `match` + `action`, then override individual fields. Inheritance cycles raise `E_POLICY_CYCLE` at engine construction.

Match criteria: `tool` (glob), `mode`, `pathPrefix` (on `input.path`/`input.paths`), `inputContains` (JSON substring).

---

## Shell hooks

Hooks can be written in any language. The harness spawns the process, writes a JSON payload to stdin, and reads a `HookResponse` from stdout.

```bash
# hooks/block_rm_rf.py (Python example)
import json, sys
msg = json.load(sys.stdin)
if msg["payload"].get("input", {}).get("path", "").startswith("/"):
    print(json.dumps({"outcome": "deny", "reason": "absolute path blocked"}))
else:
    print(json.dumps({"outcome": "continue"}))
```

```typescript
import { makeShellHook } from "./src/hooks/shellHook.js";
dispatcher.register({
  pluginId: "safety",
  event: "PreToolUse",
  fn: makeShellHook({ command: ["python3", "hooks/block_rm_rf.py"], hardTimeoutMs: 2000 }),
  timeoutMs: 3000,
});
```

stdin payload: `{ event, sessionId, turnIndex, payload }`
stdout: `{ outcome: "continue" | "deny" | "modify", reason?, patch? }`
Non-zero exit or invalid JSON → `E_HOOK_SHELL`.

---

## Observability

### Counters / OpenTelemetry

```typescript
import { FanOutCounters, Counters } from "./src/metrics/counter.js";
import { createOtelCounters } from "./src/metrics/otel.js";

const counters = new FanOutCounters([
  new Counters(),                      // in-memory snapshot
  await createOtelCounters("my-app"),  // mirrors to OTel SDK
]);
const result = await runQueryLoop({ ..., counters });
console.log(result.counters); // { "events.tool_use": 2, "policy.approve": 2, ... }
```

`createOtelCounters` lazily imports `@opentelemetry/api` — install it as a peer dep to activate. Without it the call throws `E_OTEL_UNAVAILABLE`.

### Structured logging

```typescript
import { JsonLogger, createPinoLogger } from "./src/obs/logger.js";

// Zero-dep JSON lines to stdout
const log = new JsonLogger({ sessionId: "s1" });
log.log("info", "loop.start", { mode: "assist" });
// → {"at":"2026-04-08T...","level":"info","event":"loop.start","sessionId":"s1","mode":"assist"}

// pino adapter (install pino as peer dep)
const pinoLog = await createPinoLogger({ sessionId: "s1" });
```

### Cost tracking

```typescript
import { CostTable, DEFAULT_COST_TABLE } from "./src/metrics/cost.js";

const costTable: CostTable = {
  version: "2026-04-01", provider: "anthropic", model: "claude-sonnet-4-6",
  inputPer1k: 3.0, outputPer1k: 15.0,
};
const result = await runQueryLoop({ ..., costTable });
// result.cost → { inputTokens, outputTokens, usd, provider, model, at }
// result.counters["cost.micros_usd"] → integer microdollars
```

---

## Replay and drift detection

Every run writes three audit logs:

| Log | Path | Purpose |
|---|---|---|
| Tape | `tapes/<sessionId>.jsonl` | Hash-chained stream events |
| Effects | `effects/<sessionId>.jsonl` | Pre/post file hashes + unified diffs |
| Decisions | `sessions/<sessionId>/policy.jsonl` | Per-call policy provenance |

Two determinism scripts gate CI on every push:

```bash
# Effect drift (path-agnostic, compares sorted post-hashes)
node scripts/compare-effects.mjs run-a/effects/s.jsonl run-b/effects/s.jsonl

# Decision drift — exact match on {result, winningRuleId, provenanceMode}
node scripts/compare-decisions.mjs run-a/sessions/s/policy.jsonl run-b/.../policy.jsonl

# Decision drift — semantic match on {result, toolName, effectClass} (rule-rename-invariant)
node scripts/compare-decisions.mjs --semantic run-a/.../policy.jsonl run-b/.../policy.jsonl
```

---

## Error codes

| Code | Raised by |
|---|---|
| `E_SCHEMA_PARSE` | Zod parse failure on any persisted type |
| `E_SCHEMA_VERSION` | `schemaVersion` mismatch during migration |
| `E_POLICY_SIG` | HMAC signature verification failed |
| `E_POLICY_CYCLE` | `extends:` chain forms a cycle |
| `E_HOOK_TIMEOUT` | In-process hook exceeded `timeoutMs` |
| `E_HOOK_EXIT` | In-process hook threw or returned invalid response |
| `E_HOOK_SHELL` | Shell hook exited non-zero, SIGKILL'd, or emitted invalid JSON |
| `E_TAPE_HASH` | Hash-chain integrity check failed on replay |
| `E_TAPE_MIGRATE` | Tape schema version unsupported |
| `E_CHECKPOINT_WRITE` | Crash-safe checkpoint write failed |
| `E_EFFECT_PRE_HASH` | Pre-snapshot hash capture failed |
| `E_WORKTREE_ESCAPE` | Sub-agent attempted path outside its worktree |
| `E_BUDGET_EXCEEDED` | Token / cost budget exceeded |
| `E_TOOL_FORBIDDEN` | Tool call blocked by policy in dry-run mode |
| `E_PROMPT_ASSEMBLY` | Prompt assembly produced invalid context |
| `E_MODEL_ADAPTER` | pi.dev chunk normalization error or pi package missing |
| `E_OTEL_UNAVAILABLE` | `@opentelemetry/api` peer dep not installed |
| `E_LOG_UNAVAILABLE` | `pino` peer dep not installed |
| `E_UNKNOWN` | Unclassified error |

---

## CI pipeline

Three jobs run on every push to `main`:

**`test`** — `tsc --noEmit` + `npx vitest run` (28 files / 84 tests) + `npm audit --audit-level=high`

**`golden-path`** — two independent golden-path runs → `compare-effects.mjs` (path-agnostic effect hash match)

**`replay-drift`** — same two runs → `compare-decisions.mjs` (exact) + `compare-decisions.mjs --semantic`

---

## Execution modes

| Mode | Description |
|---|---|
| `plan` | Read-only; all write tools blocked by default |
| `assist` | Interactive; policy allows most reads and scoped writes |
| `autonomous` | Unattended; strict policy + mandatory hooks |
| `worker` | Sub-agent context; signed policy required, no hook bypass |
| `dry-run` | All tool calls intercepted; effects recorded but not applied |

Full details: [`docs/EXECUTION-MODES.md`](docs/EXECUTION-MODES.md)

---

## Documentation index

| Doc | Description |
|---|---|
| [`docs/GOLDEN-PATH.md`](docs/GOLDEN-PATH.md) | Canonical end-to-end scenario |
| [`docs/ARCHITECTURE-RUNTIME.md`](docs/ARCHITECTURE-RUNTIME.md) | 5+1 layer diagram + invariants |
| [`docs/EXECUTION-MODES.md`](docs/EXECUTION-MODES.md) | Mode semantics |
| [`docs/REPLAY-MODEL.md`](docs/REPLAY-MODEL.md) | Three layers of determinism |
| [`docs/PROMPT-ASSEMBLY.md`](docs/PROMPT-ASSEMBLY.md) | Prompt-injection containment |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Trust boundaries + attack vectors |
| [`docs/HOOK-SECURITY.md`](docs/HOOK-SECURITY.md) | Hook security policy |
| [`docs/SCHEMAS.md`](docs/SCHEMAS.md) | Schema versioning + canonicalization |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Tier A/B/C roadmap + deferred items |
| [`docs/ADRs/0001-scope-tiering.md`](docs/ADRs/0001-scope-tiering.md) | Tier A/B/C decision |
| [`docs/ADRs/0002-hash-chain.md`](docs/ADRs/0002-hash-chain.md) | Tape hash chain trade-offs |
| [`docs/ADRs/0003-events-vs-compacted.md`](docs/ADRs/0003-events-vs-compacted.md) | `events` vs `compactedEvents` split |
| [`docs/ADRs/0004-tier-c-scope.md`](docs/ADRs/0004-tier-c-scope.md) | Tier C scope + deferred items |
| [`CHANGELOG.md`](CHANGELOG.md) | Full version history |

---

## Release history

| Version | Description |
|---|---|
| **v0.3.0** | pi.dev default client factory, cost tracking, policy rule inheritance, shell-contract hook executor. 28 tests files / 84 tests. |
| **v0.2.0** | OTel meter swap-in, pino/JSON structured logging, semantic decision drift, `npm audit` CI gate. 24 test files / 70 tests. |
| **v0.1.0** | First tagged release. Tier A + Tier B complete. 22 test files / 59 tests. |

---

## License

MIT — see [LICENSE](LICENSE).
