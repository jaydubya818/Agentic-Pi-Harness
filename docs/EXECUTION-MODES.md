# Execution Modes

> **Implementation status (2026-08-28).** This document is largely design
> intent stated in the present indicative, and the enforced parts were not
> previously distinguished from the aspirational ones. Grepping `src` for
> everything that branches on the loop mode returns exactly three sites:
>
> - `match.mode` in `ruleMatches` (`src/policy/engine.ts`) — mode is a policy
>   match axis, so a rule may be scoped to a mode. Real.
> - `validateWorkerModeInputs` (`src/runtime/workerControls.ts`) — `worker`
>   only: refuses to start on an unsigned policy and refuses an interactive
>   approval requester. Real.
> - `evaluateWorkerToolUse` (same file) — `worker` only: denies exclusive-class
>   tools unless `allowExclusiveTools`, and enforces `maxWritePaths` /
>   `allowedWritePathPrefixes` on `write_file`. Real.
>
> Everything else below is caller convention, not a control the harness
> applies: the per-mode policy defaults, the per-mode retry configs, the
> per-mode hook tiers (see the equivalent note in `HOOK-SECURITY.md`), and the
> sub-agent rules. `runQueryLoop` takes `tools`, `policy`, `retry`, and
> `hooks` as caller-supplied inputs and does not vary any of them by mode.
> Sections below are annotated where the text describes something that is
> **not enforced**; do not treat an unenforced row of the matrix as a
> boundary.

Every session runs in exactly one of five modes. Mode is set at session start and never changes mid-session. Mode influences policy evaluation (it's one of the match axes in `PolicyEngine`), hook trust tiers (`HOOK-SECURITY.md`), and what the loop is allowed to do when a tool is denied.

## plan

- **Intent.** Read-only exploration. The model plans; it does not mutate.
- **Policy default.** `ask` for anything that isn't explicitly readonly; `deny` for writes.
- **Hooks.** All tiers allowed (module/exec/http).
- **Sub-agents.** Allowed, inherit plan.
- **Compaction.** Allowed.
- **Effect recorder.** Still runs — a plan session should produce an empty effect log. If it doesn't, that's a bug to investigate.
- **Typical use.** "What changed in this repo last week?" "Walk the call graph." "Draft a migration plan but don't execute."

## assist

- **Intent.** Interactive co-pilot. Human in the loop for each tool call by default.
- **Policy default.** `ask` — unsafe tools prompt, safe tools pass.
- **Hooks.** All tiers allowed.
- **Sub-agents.** Allowed.
- **Approvals.** Milestone 7 supervised-intervention layer may build runtime approval packets for `ask` decisions and mediate a final allow/deny outcome.
- **Retry.** Default config (3 attempts, 10ms base, 200ms cap).
- **Typical use.** IDE-attached coding, pairing, debugging.

## autonomous

- **Intent.** Run without a human in the loop, but on a trusted workstation with a real user's credentials.
- **Policy default.** `approve` for tools whose rules match; `deny` otherwise (fail-closed).
- **Hooks.** All tiers allowed, but `PreToolUse` hooks are mandatory for any exclusive-class tool.
- **Sub-agents.** Allowed, must run in worktrees (`src/subagents/worktree.ts`) with child artifact separation.
- **Scheduling.** Explicit `readonly | serial | exclusive` classifier may be supplied; visible result collation remains in original event order.
- **Signed policy.** Recommended but not required. Unsigned policy logs a warning and runs.
- **Typical use.** Scheduled refactors, nightly migrations, long bug hunts.

## worker

- **Intent.** Autonomous execution on untrusted or remote infrastructure. Highest trust bar.
- **Policy default.** `deny`. Every tool call must match an explicit approve rule.
- **Signed policy.** Mandatory. Unsigned or tampered policy → `E_POLICY_SIG`, session aborts before first event.
- **Hooks.** `module` only. `exec` and `http` hooks in the manifest → refuse to start.
- **Sub-agents.** Allowed, always in worktrees, always inherit worker.
- **Approvals.** Interactive approval requesters are disallowed by worker controls.
- **Worker controls.** May enforce blast-radius limits (for example allowed write prefixes) and deny exclusive tools by default.
- **Effect recorder.** Mandatory; `effectLogPath` cannot be `null`.
- **Retry.** More conservative (6 attempts, 100ms base, 5s cap) because a human isn't watching.
- **Typical use.** CI agents, fleet workers, sandboxed long-running jobs.

## dry-run

- **Intent.** Rehearse a session against a replay tape or mock model without any side effects.
- **Policy default.** whatever the underlying config says — decisions are still recorded.
- **Hooks.** `module` only; `exec`/`http` fail closed (same reason as worker: we don't want a "dry run" to page an on-call).
- **Tools.** All tool implementations are swapped for pure-read stubs. Writes are simulated; the effect recorder still captures would-be diffs.
- **Typical use.** Policy change regression tests, replay-drift CI, capacity planning.

> **Not enforced, and `dry-run` is inert.** The string `"dry-run"` appears in
> `src` only inside the `LoopMode` unions and the zod enums that mirror them:
> no code branches on it. Nothing swaps `LoopInputs.tools` for stubs, so a
> caller that selects `mode: "dry-run"` and passes its real `write_file`
> implementation gets real writes and a real effect log. Simulated writes are
> the caller's job today.
>
> This bullet also promised `rollbackConfidence: "best_effort"` on the effect
> record. There is no such field: `EffectRecordSchema`
> (`src/schemas/effectRecord.ts`) does not declare one, `capturePost` does not
> produce one, and `appendEffectRecord` writes through `safeParse`, which
> would strip it. It has been removed from the sentence rather than qualified
> — there was nothing to qualify.

## Mode compatibility matrix

| feature              | plan | assist | auto | worker | dry-run |
|----------------------|:----:|:------:|:----:|:------:|:-------:|
| writes allowed       |  -   |   ✓    |  ✓   |   ✓    |    -    |
| ask prompts          |  ✓   |   ✓    |  -   |   -    |    -    |
| signed policy req    |  -   |   -    |  -   |   ✓    |    -    |
| shell hooks allowed  |  ✓   |   ✓    |  ✓   |   -    |    -    |
| sub-agents allowed   |  ✓   |   ✓    |  ✓   |   ✓    |    ✓    |
| effect log required  |  -   |   -    |  ✓   |   ✓    |    -    |

> **Only the `signed policy req` row is enforced**, by
> `validateWorkerModeInputs`. Two other rows are not what they look like:
>
> - `writes allowed` is not checked against the mode anywhere. A write is
>   allowed or denied by the policy document, the hooks, and — in `worker`
>   only — the worker controls. A `plan`-mode session with an approving
>   policy writes files.
> - `effect log required` is stronger than the table says and is not
>   mode-scoped: `LoopInputs.effectLogPath` is a non-optional `string` for
>   every mode, so the loop always has somewhere to write effect records.
