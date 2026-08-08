# AGENTS.md

Guidance for coding agents working in this repository.

## What this repo is

Governed execution harness for Pi-supervised worker runtimes: a hardened
Pi <-> Hermes bridge, versioned execution contracts (v2), persistent run
state, KB/Wiki write-policy enforcement, deterministic golden-path replay,
and crash-safe artifacts. TypeScript, ESM, Node >= 20.11.

## Commands

```bash
npm ci                 # install (node-pty compiles a native addon; see README note for npm v12+)
npm run typecheck      # tsc --noEmit
npm test               # vitest run (unit + chaos + fuzz; ~35s)
npm run lint           # eslint src tests
npm run build          # tsc -> dist/
npm run golden:verify  # verify the canonical golden tape
```

All four of typecheck, test, lint, and build must pass before a change is done.

## Layout

- `src/hermes/` — bridge server (`httpBridge.ts`), worker adapter, transports, contract v2, KB access policy
- `src/loop/` — the core query loop (`query.ts`): policy, hooks, approvals, effects, retry, compaction
- `src/policy/`, `src/hooks/`, `src/approvals/` — decision engine, mediation hooks, approval runtime
- `src/replay/`, `src/effect/`, `src/session/` — tape recorder/replay, effect capture, crash-safe persistence
- `src/cli/` — thin CLI shells; shared arg helpers in `src/cli/args.ts`
- `tests/unit|chaos|fuzz|bench` — vitest suites; `goldens/canonical/` is the frozen golden tape
- Contracts and policies are documents first: `PI_HERMES_CONTRACT_V2.md`, `KB_ACCESS_POLICY_V1.md`, `GOVERNED_EXECUTION_MODEL_V1.md`, `docs/HOOK-SECURITY.md`

## Hard rules

- Never weaken a fail-closed path. The bridge refuses unauthenticated non-loopback binds; KB writes/deletes/promotions are policy-classified (including symlink realpath checks); worker env/id inputs are validated at the boundary. Changes here need a test proving the guard still holds.
- Hook failures are deliberately fail-open for the loop ("a hook failure is never a policy decision" — docs/HOOK-SECURITY.md). Do not "fix" this to fail-closed.
- Persistence is write-rename+fsync (`safeWriteJson`); event logs are append-only JSONL that tolerate one torn line on load. Preserve both properties.
- The golden tape under `goldens/` is frozen; `goldenFreeze.test.ts` will fail if a change alters canonical hashing or event shapes. Never regenerate it to make a test pass without understanding why it changed.
- Do not print or persist secrets: no bearer tokens in logs, dry-run output, or persisted preflight denials.
- Update `CHANGELOG.md` ([Unreleased]) for user-visible fixes and features; Conventional Commits (`fix:`, `feat:`, `test:`, `docs:`, `chore:`).

## Conventions

- Surgical diffs; match the existing style. Comments explain *why* a guard exists (often citing the failure it prevents) — keep that habit.
- New behavior lands with a regression test beside the module's existing test file in `tests/unit/`.
- Response style for assistant output in this repo is defined in `CLAUDE.md` (concise, low-fluff).
