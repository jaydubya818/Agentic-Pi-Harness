# Hook Security

## Principle: in-process first, shell last

Hooks extend the harness at well-defined lifecycle points (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`). Every hook runs in one of three modes, listed in order of preference:

1. **In-process** (`type: "module"`). A TypeScript function imported from a code-reviewed plugin. Trusted. No IPC. Default for all first-party hooks.
2. **Shell** (`type: "exec"`). An external executable. Untrusted. Strict contract (below).
3. **HTTP** (`type: "http"`). An external service. Untrusted. Same contract as shell plus TLS + bearer token.

In **worker mode**, only `type: "module"` hooks from a signed plugin manifest are allowed. Shell and HTTP hooks fail closed.

## Shell hook contract

1. **Argv is static.** The `exec` path and argv are fixed in the plugin manifest. The harness never templates user or model content into argv. Enforced by a semgrep rule in CI.
2. **Input on stdin as JSON.** A single JSON object: `{ event, sessionId, turnIndex, payload }`. No env vars derived from model output.
3. **Output on stdout as JSON.** A single JSON object validated against `HookResponseSchema`. Anything else → hook is treated as failed, session continues with `hookResult: "error"` logged.
4. **Timeout.** Hard kill at `hook.timeoutMs` (default 5s). No partial reads honored.
5. **Working directory.** Hook runs in a scratch dir, not the session workdir. It cannot read session files unless the harness passes paths in `payload`.
6. **Environment.** Cleared except `PATH`, `HOME`, `PI_HOOK_EVENT`, `PI_SESSION_ID`. No secrets, no `AWS_*`, no `ANTHROPIC_API_KEY`.
7. **Exit code.** `0` → success; non-zero → `hookResult: "error"`. The loop never treats a hook failure as a policy decision.

## HTTP hook contract

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

## Audit

Every hook invocation writes one `HookAuditRecord` to the effect log:
```
{ event, pluginId, hookType, durationMs, exitCode, responseDigest, schemaVersion }
```
No hook stdout/stderr content is persisted unless `--trace` is on.

## Review checklist

- [ ] semgrep rule: `spawn|execFile` with non-literal argv in hook-exec path fails CI
- [ ] worker-mode test: shell hook in manifest → harness refuses to start
- [ ] timeout test: 10s sleep hook killed at 5s, session continues
- [ ] env-leak test: hook that dumps env cannot see `ANTHROPIC_API_KEY`
