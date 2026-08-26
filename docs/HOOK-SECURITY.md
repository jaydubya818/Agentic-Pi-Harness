# Hook Security

> **Implementation status (2026-08-26).** This document is part design intent,
> part shipped behaviour, and the two were not previously distinguished. What
> exists in `src/hooks/` today is: `mediation.ts` (the `PreToolUse`/`PostToolUse`
> path the loop actually calls, from `src/loop/query.ts`), `dispatcher.ts` (a
> general in-process dispatcher with no production caller), and `shellHook.ts`
> (the shell contract executor, likewise with no production caller). There is
> no HTTP hook implementation, no plugin manifest loader, and no signature
> verification. Sections below are annotated where the text describes a
> control that is **not enforced**. Do not treat an unenforced row of the
> trust-tier table as a boundary.

## Principle: in-process first, shell last

Hooks extend the harness at well-defined lifecycle points (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`). Every hook runs in one of three modes, listed in order of preference:

1. **In-process** (`type: "module"`). A TypeScript function imported from a code-reviewed plugin. Trusted. No IPC. Default for all first-party hooks.
2. **Shell** (`type: "exec"`). An external executable. Untrusted. Strict contract (below).
3. **HTTP** (`type: "http"`). An external service. Untrusted. Same contract as shell plus TLS + bearer token.

In **worker mode**, only `type: "module"` hooks from a signed plugin manifest are allowed. Shell and HTTP hooks fail closed.

> **Not enforced.** No code reads a hook `type`, and no hook API carries the
> loop mode: `HookContext` (`dispatcher.ts`) and the `PreToolHookContext` /
> `PostToolHookContext` pair (`mediation.ts`) have no `mode` field, so there
> is nowhere for this rule to be applied. `makeShellHook` returns an
> `InProcessHook`, so a shell hook registered through it is indistinguishable
> from a module hook at every point downstream. There is also no manifest and
> no signature check, so "from a signed plugin manifest" constrains nothing.
> Registration is the only gate that exists, and it is the caller's to apply.

## Shell hook contract

1. **Argv is static.** The `exec` path and argv are fixed in the plugin manifest. The harness never templates user or model content into argv. *(The "enforced by a semgrep rule in CI" claim previously made here was not true: there is no semgrep config in the repo and `.github/workflows/ci.yml` runs no such step. The property does hold today by construction — `runShellHook` takes `spec.command` as a fixed `string[]` and passes it straight to `spawn` with no shell, and `ctx.payload` reaches the hook only over stdin — but nothing stops a future caller from building `command` out of model output.)*
2. **Input on stdin as JSON.** A single JSON object: `{ event, sessionId, turnIndex, payload }`. No env vars derived from model output.
3. **Output on stdout as JSON.** A single JSON object validated against `HookResponseSchema`. Anything else → hook is treated as failed, session continues with `hookResult: "error"` logged.
4. **Timeout.** Hard kill at `spec.hardTimeoutMs`, which defaults to **10s**, not the 5s previously stated here (`shellHook.ts`). The kill is a `SIGKILL` to the child's whole process group on POSIX, so hung descendants die with it. No partial reads honored. Note that the dispatcher applies its own separate `RegisteredHook.timeoutMs` race on top; when both are set the shorter one wins and the shell process is left to the hard timeout to reap.
5. **Working directory.** Hook runs in a scratch dir, not the session workdir. It cannot read session files unless the harness passes paths in `payload`.
6. **Environment.** Cleared except `PATH`, `HOME`, `PI_HOOK_EVENT`, `PI_SESSION_ID`. No secrets, no `AWS_*`, no `ANTHROPIC_API_KEY`.
7. **Exit code.** `0` → success; non-zero → `hookResult: "error"`. The loop never treats a hook failure as a policy decision.

## HTTP hook contract

> **Unimplemented.** There is no HTTP hook executor in `src/hooks/` — the
> directory contains only `dispatcher.ts`, `mediation.ts`, and `shellHook.ts`.
> Nothing reads `certFingerprint` or `~/.pi/keys/hooks/<pluginId>.token`.
> This section is a specification for work not yet done.

Same as shell plus:
- HTTPS only. TLS cert pinned in manifest (`certFingerprint`).
- Bearer token from `~/.pi/keys/hooks/<pluginId>.token`, never from env.
- Request body = stdin JSON. Response body = stdout JSON.
- 5s connect + 5s read timeout.

## Trust tiers

| Mode          | module | exec | http |
|---------------|:------:|:----:|:----:|
| plan          | ✓      | ✓    | ✓    |
| assist        | ✓      | ✓    | ✓    |
| autonomous    | ✓      | ✓    | ✓    |
| worker        | ✓      | ✗    | ✗    |
| dry-run       | ✓      | ✗    | ✗    |

> **Not enforced — this table is intent, not behaviour.** See the note under
> "Principle" above. Every `✗` in it is currently a `✓` in practice, because
> nothing inspects a hook's type or the loop's mode before running it.

## Audit

The intended record is one `HookAuditRecord` per hook invocation:
```
{ event, pluginId, hookType, durationMs, exitCode, responseDigest, schemaVersion }
```
No hook stdout/stderr content is persisted unless `--trace` is on.

> **Not enforced.** Two gaps. First, nothing writes these records anywhere:
> `HookDispatcher.dispatch` builds an `audits` array and returns it to its
> caller, and it has no caller outside tests, so no `HookAuditRecord` ever
> reaches the effect log or any other artifact. Second, the hook path the loop
> *does* run — `dispatchPreToolHooks` / `dispatchPostToolHooks` in
> `mediation.ts` — produces `ToolHookRunSummary`, not `HookAuditRecord`, and
> carries no `pluginId`, `durationMs`, or `responseDigest`.
>
> `hookType` is also not a real field: `dispatcher.ts` hardcodes it to
> `"module"` at both call sites. A shell hook wrapped by `makeShellHook` and
> registered on the dispatcher executes its external binary and is recorded as
> `hookType: "module"` — so if these records were persisted, they would
> actively misreport which trust tier ran. Fixing the audit sink without
> deriving `hookType` from the registration would write that false claim into
> the artifact, which is the failure mode `docs/HARNESS-INVARIANTS.md` calls
> out for evidence generally.

## Review checklist

Ticked against the tree as of 2026-08-26 — two of these were already done and
had simply never been marked.

- [ ] semgrep rule: `spawn|execFile` with non-literal argv in hook-exec path fails CI — **not done**; no semgrep config exists and CI runs no such step.
- [ ] worker-mode test: shell hook in manifest → harness refuses to start — **not done**, and not testable as written: there is no manifest, and no mode gate for such a test to exercise.
- [x] timeout test: 10s sleep hook killed at 5s, session continues — `tests/unit/shellHook.test.ts` "SIGKILLs a hung hook and its descendants at the hard timeout", which also asserts the process-group kill reaches descendants.
- [x] env-leak test: hook that dumps env cannot see `ANTHROPIC_API_KEY` — `tests/unit/shellHook.test.ts` "clears the hook environment except PATH, HOME, and PI_* variables".
