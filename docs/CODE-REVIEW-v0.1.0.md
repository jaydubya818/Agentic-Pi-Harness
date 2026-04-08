# Code review — v0.1.0 final pass

Reviewer: Claude (engineering:code-review skill)
Scope: diff from e36ce84 (initial) → ec6f739 (v0.1.0 tag)
Files reviewed: 54 changed / +3700 / −180

## Verdict

**Ship.** No blocking issues. Three paper cuts documented below as
follow-ups, none gate v0.1.0.

## What I checked

- Hash chain integrity (every `recordHash` derives from framed canonical of
  the record minus `recordHash`, `prevHash` carries forward) — ✅
- No retry path double-writes the tape (manual `iter.next()` + `withRetry`
  wraps a single `next()` call, not the loop) — ✅
- `EffectScope` is per-call — two concurrent calls to the same path cannot
  clobber each other's pre-snapshot — ✅ (test: `loopConcurrentWrites.test.ts`)
- Compaction never mutates `events` — it produces a new array on the
  `compactedEvents` view — ✅ (ADR 0003)
- Worker mode refuses unsigned policy — ✅ (4 tests in `workerModePolicy.test.ts`)
- Sub-agent worktree cannot escape `mkdtemp` base — ✅ (guard in `createWorktree`)
- Prompt-injection containment handles nested tags, ANSI, and control chars
  — ✅ (fuzz test, 200 iterations)
- Hook dispatcher: timeout recorded as `exitCode: 1`, deny short-circuits,
  subsequent hooks still run — ✅
- `package.json` `files` field prevents junk in published tarball — ✅

## Paper cuts (not blocking)

### 1. `placeholderApprove` is still referenced in `src/loop/query.ts`
Item #4 from the tech-debt audit. I left it as a no-policy fallback. It's
not dead code, but the name is misleading — it implies Tier A legacy when
it's actually the "no policy configured" branch. **Fix for 0.1.1:** rename
to `defaultApproveAll` and add a TSDoc comment explaining it's intentional.

### 2. `vitest.config.ts.timestamp-*.mjs` leaked into three commits
Root cause: `.gitignore` changes inside the sandbox didn't write through to
the host filesystem on the first pass. Now fixed in commit `51cc83d`, but
the pattern (`.pi-out*/`, `.pi-work*/`, `vitest.config.ts.timestamp-*.mjs`)
should go into a shared `.gitignore.shared` file that the host-release
script appends to, so it can't regress.

### 3. Node.js 20 deprecation warnings on CI
GitHub Actions is deprecating Node 20 in September 2026. `actions/checkout@v4`
and `actions/setup-node@v4` still work but print warnings. **Fix for 0.1.1:**
bump to `v5` once those actions are released and pin to Node 24.

## Positive notes

- The LCS-based `unifiedDiff` in `src/effect/recorder.ts` is a real diff,
  not a stub. No dependency needed. Clean O(nm) implementation with a
  proper DP table. Could be optimized to O(min(n,m)) but not worth it at
  current sizes.
- `scripts/compare-effects.mjs` correctly ignores absolute paths by
  comparing sorted hash values + tool name + binary flag + rollback
  confidence. This is the right granularity for replay drift.
- `defaultClassify` in `src/retry/stateMachine.ts` distinguishes
  `context_overflow` from `transient`, which is exactly what you want —
  context overflow should bubble as `E_BUDGET_EXCEEDED`, not retry silently.
- Zod + `schemaVersion` on every persisted type is the discipline that
  makes the migration story work. Don't regress on this.

## Security posture

- HMAC-SHA256 signed policy: ✅
- Framed canonicalization prevents length-extension and framing ambiguity: ✅
- No `eval`, no `Function()`, no dynamic `import()` of untrusted paths: ✅
- Sub-agent worktrees cannot escape base: ✅
- Tool output wrapped as `trusted="false"`: ✅
- No runtime shell hook executor in v0.1.0 (documented, not wired): ✅

No CVE candidates in the diff.
