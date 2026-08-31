# Threat Model (Skeleton)

**Status: skeleton. Expand before autonomous/worker mode ships.**

## Trust boundaries

1. **User ↔ Harness.** User is trusted. Harness validates user inputs only for safety (e.g. path traversal in slugs), not for authority.
2. **Harness ↔ Model provider.** Provider output is **untrusted data**. See PROMPT-ASSEMBLY.md.
3. **Harness ↔ Tools.** Tool inputs come from the model → untrusted. Tool outputs → untrusted. Tool manifests → trusted (code-reviewed).
4. **Harness ↔ Policy files.** Enterprise/project/user policy files are trusted in interactive mode (warn on missing signature). In worker mode, policy MUST be HMAC-signed or the harness refuses to start.
5. **Harness ↔ Hooks.** In-process hooks are trusted (code-reviewed). Shell/HTTP hooks are untrusted external services.
6. **Parent ↔ Sub-agent.** Parent trusts child's workdir is isolated (git worktree). Child cannot mutate parent state.
7. **Harness ↔ Replay tapes.** Tapes from this machine are trust-on-first-use (hash chain); tapes from other sources are untrusted until `verify` passes. **Scope of that check:** `verify` attests the *schema-covered content* of a tape, not its bytes. `readTape` parses each line with `TapeRecordSchema` and zod strips unknown keys, so a record carrying extra JSON keys rehashes to the stored `recordHash` and verifies with an unchanged digest (pinned in `tests/chaos/tapeCorruption.test.ts`). Replay is unaffected — the stripped keys never reach it — but a passing `verify` is not a statement that the file is byte-for-byte what the recorder wrote.
8. **Local network ↔ Hermes bridge.** The bridge is an HTTP control plane whose `/sessions` and `/execute` routes spawn worker processes with a caller-chosen workdir and environment. Binding loopback is a *reachability* control, not an authentication one: everything running as the same OS user — including a web page in the operator's browser — can reach it. Callers are authenticated by bearer token when one is configured, and by "must not look like a browser" always.

## Attack vectors

| Vector | Mitigation |
|---|---|
| Prompt injection via tool output | `<tool_output trusted="false">` wrapping; system prompt directive; sanitization; eval coverage |
| Malicious `PI.md` in a cloned repo | `PI.md` loaded as **user** message wrapped in `<system-reminder>`, never as system prompt; digest recorded in provenance manifest |
| Shell hook argv injection | JSON-on-stdin only; static exec path; no templating; semgrep CI rule |
| Policy file tampering in worker mode | HMAC-SHA256 sig; fail closed on mismatch; policy digest recorded in the provenance manifest and the tape header (**not** in `SessionContext`, which has no `policyDigest` field and is not persisted — see `docs/SCHEMAS.md`) |
| Approval UI spoofing / TOCTOU | Nonce + content hash in every packet; responses must reference hash |
| Sub-agent worktree escape | Slug regex; validated branch prefix; `maxBlastRadius` path enforcement in Effect runtime |
| Replay tape tampering | Hash chain per record; `verify` CLI; worker mode requires signed tapes (Tier B). Detects any change to schema-covered content; does **not** detect added unknown keys — see boundary 7 |
| Checkpoint corruption mid-crash | Write-rename + fsync (`safeWriteJson` → `safeWriteFileAtomic`). **No schema-validate-on-read**: `CheckpointSchema` is used as a write-time type only and no reader validates it. The one reader in the tree, `tryReadJson` in `src/sofie/runtime.ts`, `JSON.parse`s and returns `null` on failure, so a damaged checkpoint is indistinguishable from an absent one (pinned in `tests/unit/sofieRuntime.test.ts`; tracked in `docs/NIGHTLY-BACKLOG.md`) |
| Secret exfiltration via `web_fetch` | `web_fetch` blocked in plan mode by default; allowlist in interactive mode; audit to effect log |
| Infinite retry loops | `MAX_ATTEMPTS=8` hard cap; persistent mode has 6-hour ceiling |
| Budget bypass via sub-agent fanout | Budget escrow: parent debits on spawn, child credits back unused |
| Forbidden path writes | Effect runtime enforces `maxBlastRadius` + forbidden glob list before every mutating tool |
| Protected branch mutation | Pre-commit/pre-push git hooks installed in every worktree; re-checked at every PostToolUse |
| Unauthenticated bridge exposed off-host | `start()` refuses a non-loopback bind with no `authToken`; a present-but-blank token is a misconfiguration and also refuses to start (it must never read as "auth disabled") |
| Browser CSRF against the loopback bridge | A page on any origin can POST to `http://127.0.0.1:<port>` without a preflight. The bridge refuses every request carrying an `Origin` header — it is a machine-to-machine JSON API and has no browser clients |
| DNS rebinding onto the loopback bridge | An attacker-controlled hostname re-pointed at `127.0.0.1` makes the browser treat the bridge as same-origin. The `Host` header must name a loopback address |
| Bridge bearer token in `ps` output | `--auth-token` is visible to every local process; `PI_HERMES_BRIDGE_TOKEN` (or the LaunchAgent's `0600` token file) is the supported path. **Not yet enforced** |
| Slowloris / socket exhaustion on the bridge | `headersTimeout` 15s, `requestTimeout` 30s, request bodies capped at 4 MiB |

## Non-goals for v0.1

- Defending against a malicious *model provider* (we trust the API endpoint).
- Defending against a compromised OS / root user.
- Remote attestation / TPM integration.
- Multi-tenant isolation within one OS user.

## Review checklist (before autonomous mode ships)

- [ ] Every attack vector above has a unit test or eval scenario
- [ ] No `execFile`/`spawn` in hook-execution code accepts dynamic argv
- [ ] `tool_output` wrapping unit test passes
- [ ] Signed policy fail-closed test passes
- [ ] Hash-chain tamper detection test passes
- [ ] Approval nonce mismatch test passes
- [ ] Worktree escape test passes (attempted traversal slug blocked)
- [x] Bridge refuses a non-loopback bind without a token, and refuses a blank token
- [x] Bridge rejects rebound `Host` headers and any request carrying `Origin`
