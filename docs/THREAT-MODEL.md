# Threat Model (Skeleton)

**Status: skeleton. Expand before autonomous/worker mode ships.**

## Trust boundaries

1. **User ↔ Harness.** User is trusted. Harness validates user inputs only for safety (e.g. path traversal in slugs), not for authority.
2. **Harness ↔ Model provider.** Provider output is **untrusted data**. See PROMPT-ASSEMBLY.md.
3. **Harness ↔ Tools.** Tool inputs come from the model → untrusted. Tool outputs → untrusted. Tool manifests → trusted (code-reviewed).
4. **Harness ↔ Policy files.** Enterprise/project/user policy files are trusted in interactive mode (warn on missing signature). In worker mode, policy MUST be HMAC-signed or the harness refuses to start.
5. **Harness ↔ Hooks.** In-process hooks are trusted (code-reviewed). Shell/HTTP hooks are untrusted external services.
6. **Parent ↔ Sub-agent.** Parent trusts child's workdir is isolated (git worktree). Child cannot mutate parent state.
7. **Harness ↔ Replay tapes.** Tapes from this machine are trust-on-first-use (hash chain); tapes from other sources are untrusted until `verify` passes.

## Attack vectors

| Vector | Mitigation |
|---|---|
| Prompt injection via tool output | `<tool_output trusted="false">` wrapping; system prompt directive; sanitization; eval coverage |
| Malicious `PI.md` in a cloned repo | `PI.md` loaded as **user** message wrapped in `<system-reminder>`, never as system prompt; digest recorded in provenance manifest |
| Shell hook argv injection | JSON-on-stdin only; static exec path; no templating; semgrep CI rule |
| Policy file tampering in worker mode | HMAC-SHA256 sig; fail closed on mismatch; signed policy digest in SessionContext |
| Approval UI spoofing / TOCTOU | Nonce + content hash in every packet; responses must reference hash |
| Sub-agent worktree escape | Slug regex; validated branch prefix; `maxBlastRadius` path enforcement in Effect runtime |
| Replay tape tampering | Hash chain per record; `verify` CLI; worker mode requires signed tapes (Tier B) |
| Checkpoint corruption mid-crash | Write-rename + fsync + schema-validate-on-read |
| Secret exfiltration via `web_fetch` | `web_fetch` blocked in plan mode by default; allowlist in interactive mode; audit to effect log |
| Infinite retry loops | `MAX_ATTEMPTS=8` hard cap; persistent mode has 6-hour ceiling |
| Budget bypass via sub-agent fanout | Budget escrow: parent debits on spawn, child credits back unused |
| Forbidden path writes | Effect runtime enforces `maxBlastRadius` + forbidden glob list before every mutating tool |
| Protected branch mutation | Pre-commit/pre-push git hooks installed in every worktree; re-checked at every PostToolUse |

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
