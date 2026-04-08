#!/usr/bin/env bash
# Run this on your host (not the sandbox). It:
#   1. clears stale git lock files
#   2. unstages junk (.pi-out2, .pi-work2, vitest timestamp files)
#   3. stages everything else
#   4. commits
#   5. adds the GitHub remote if missing
#   6. pushes main + tag v0.1.0-rc.1
#
# Usage:  bash scripts/host-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> clearing stale locks"
rm -f .git/index.lock .git/HEAD.lock .git/config.lock || true

echo "==> unstaging junk from index"
git rm -rf --cached --ignore-unmatch .pi-out2 .pi-work2 >/dev/null 2>&1 || true
git rm --cached --ignore-unmatch 'vitest.config.ts.timestamp-*.mjs' >/dev/null 2>&1 || true

echo "==> removing junk from disk"
rm -rf .pi-out2 .pi-work2
rm -f vitest.config.ts.timestamp-*.mjs

echo "==> installing husky (one-time)"
npm install --no-audit --no-fund --silent

echo "==> typecheck + tests"
npx tsc --noEmit
npx vitest run

echo "==> staging release"
git add -A

echo "==> committing"
git commit -m "$(cat <<'MSG'
feat(tier-b): v0.1.0-rc.1 — policy engine, hooks, compaction, retry, worktrees, replay drift

Tier B complete:
- PolicyEngine with full provenance + HMAC signed policy (worker-mode strict)
- In-process hook dispatcher with per-hook timeouts and canonical audit digests
- Retry state machine (transient/rate_limit/context_overflow/fatal)
- 4-strategy compaction with CompactionRecord audit trail
- Concurrency classifier (readonly parallel / serial per-name / exclusive drain)
- Sub-agent git worktree isolation with escape guard
- Level B (effects) and Level C (decisions) replay drift detection
- Real pi.dev provider seam with lazy import + chunk normalization
- LoopResult.events vs compactedEvents split (ADR 0003)

Phase 1 tech-debt cleared:
- canonicalize() in hook dispatcher digest (stable audit hashes)
- replay CLI added (src/cli/replay.ts), package.json scripts all resolve
- sessionId collision-proof (ms + randomUUID suffix)

Phase 2 worker-mode trust:
- worker-mode signed-policy refusal tests (missing/wrong-key/malformed sig)
- sub-agent worktree isolation tests (main repo untouched, dispose cleans up)
- hook dispatcher concurrency + timeout tests
- hash-chain microbench (p99 < 2ms per ADR 0002, currently ~1.3ms)
- schema-drift pre-commit guard (husky + scripts/check-schema-drift.mjs)

Release hygiene:
- LICENSE (MIT)
- README updated for v0.1.0-rc with ADR 0002/0003 links
- package.json "files" field restricts publish to dist/docs/README/LICENSE
- version bumped 0.0.1 -> 0.1.0-rc.1

Tests: 22 files / 59 passing, tsc clean.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
MSG
)"

echo "==> ensuring origin remote"
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/jaydubya818/Agentic-Pi-Harness.git
fi

echo "==> pushing main"
git branch -M main
git push -u origin main

echo "==> tagging v0.1.0-rc.1"
git tag -a v0.1.0-rc.1 -m "v0.1.0-rc.1 — Tier B release candidate"
git push origin v0.1.0-rc.1

echo ""
echo "✔ done. https://github.com/jaydubya818/Agentic-Pi-Harness/releases/tag/v0.1.0-rc.1"
