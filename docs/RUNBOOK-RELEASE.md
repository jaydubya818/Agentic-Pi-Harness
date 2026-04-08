# Runbook — cutting a release

For every tagged release of Agentic-Pi-Harness. Steps are idempotent —
running twice is safe.

## Preconditions

- Working tree clean (`git status` shows nothing)
- On `main` and up to date with `origin/main`
- Last CI run on `main` is green (`gh run list --limit 1 --workflow=ci.yml`)
- You have `npm publish` rights for the package (if publishing to npm)

## Steps

### 1. Confirm CI is green
```bash
gh run list --limit 1 --workflow=ci.yml --json conclusion -q '.[0].conclusion'
# expect: success
```

### 2. Update version + changelog
```bash
# Bump version (patch/minor/major) — this edits package.json
npm version <patch|minor|major> --no-git-tag-version
# Add a section to CHANGELOG.md with the new version and the diff since last tag
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

### 3. Run the full gate locally
```bash
npx tsc --noEmit
npx vitest run
npx tsx src/cli/run.ts ./.pi-work ./.pi-out
npx tsx src/cli/verify.ts $(ls ./.pi-out/tapes/*.jsonl | head -1)
```
All four must pass. If any fail, STOP and fix on `main` first.

### 4. Commit and tag
```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line description>"
git push origin main
git push origin vX.Y.Z
```

### 5. Wait for the tag's CI run to go green
```bash
gh run watch $(gh run list --limit 1 --workflow=ci.yml --json databaseId -q '.[0].databaseId') --exit-status
```

### 6. Publish to npm (if applicable)
```bash
npm pack --dry-run    # review the tarball contents
npm publish           # or --tag next for a pre-release
```

### 7. Create the GitHub release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n "/^## \[X.Y.Z\]/,/^## /p" CHANGELOG.md | sed '$d')
```

## Rollback

### If CI goes red after tag
1. Do NOT delete the tag. Tags are permanent once pushed.
2. Create a patch release (`vX.Y.(Z+1)`) that fixes the regression.
3. If the bug is in npm-published code, publish `vX.Y.(Z+1)` and `npm
   deprecate agentic-pi-harness@vX.Y.Z "superseded by vX.Y.(Z+1)"`.

### If a security issue is found in published code
1. Unpublish within 72h window: `npm unpublish agentic-pi-harness@vX.Y.Z`
2. If >72h: issue a patch and `npm deprecate` the bad version with a
   CVE reference.
3. Publish a GitHub security advisory.

## Gotchas discovered in v0.1.0 release

- Sandbox environments cannot unlink `.git/*.lock` files. Release
  commits must run on the host, not inside a container mount. See
  `scripts/host-release.sh` for the script we used.
- GitHub-hosted runners are 3–5x slower than a laptop on hash-bench.
  `tests/bench/hashChain.bench.test.ts` has env-aware ceilings; don't
  tighten the local one without also tightening CI's.
- `npm version` without `--no-git-tag-version` will create an extra tag
  that collides with step 4. Always pass the flag.
