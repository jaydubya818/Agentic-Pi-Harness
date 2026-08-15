import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PiHarnessError } from "../errors.js";

const pexec = promisify(execFile);

/**
 * Every git invocation here runs unattended inside a sub-agent lifecycle, so
 * none of them may block forever. `git worktree add` on a cold/large repo can
 * legitimately take a while; `remove`/`branch -D` are fast but can park on a
 * stale index.lock held by another process. Without a timeout a wedged git
 * hangs createWorktree (or, worse, dispose(), whose failures are swallowed)
 * with no way out. maxBuffer is raised off Node's 1 MiB default so a chatty
 * git doesn't fail with ENOBUFS instead of its real error.
 */
const GIT_EXEC_OPTIONS = {
  timeout: 120_000,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Slugs become both a filesystem path segment and a git branch component.
 * Reject anything that could traverse directories (`../evil`), inject git
 * ref syntax (`..`, `~`, `^`, spaces), or start with `-` or `.`.
 */
export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) {
    throw new PiHarnessError("E_WORKTREE_ESCAPE", "unsafe worktree slug", { slug });
  }
}

/**
 * Tier B sub-agent worktree isolation.
 * Creates a short-lived git worktree for a sub-agent. Guards against path
 * escape and enforces cleanup via a disposer.
 */

export interface Worktree {
  path: string;
  branch: string;
  dispose(): Promise<void>;
}

export async function createWorktree(repoRoot: string, slug: string): Promise<Worktree> {
  assertSafeSlug(slug);
  const abs = resolve(repoRoot);
  const base = await mkdtemp(join(tmpdir(), "pi-wt-"));
  const branch = `pi/${slug}-${Date.now().toString(36)}`;
  const wtPath = join(base, slug);

  if (!wtPath.startsWith(base + sep)) {
    throw new PiHarnessError("E_WORKTREE_ESCAPE", "worktree path outside base", { wtPath, base });
  }

  try {
    await pexec("git", ["-C", abs, "worktree", "add", "-b", branch, wtPath, "HEAD"], GIT_EXEC_OPTIONS);
  } catch (e) {
    await rm(base, { recursive: true, force: true });
    throw new PiHarnessError("E_UNKNOWN", `git worktree add failed: ${(e as Error).message}`);
  }

  return {
    path: wtPath,
    branch,
    dispose: async () => {
      try { await pexec("git", ["-C", abs, "worktree", "remove", "--force", wtPath], GIT_EXEC_OPTIONS); } catch { /* ignore */ }
      try { await pexec("git", ["-C", abs, "branch", "-D", branch], GIT_EXEC_OPTIONS); } catch { /* ignore */ }
      await rm(base, { recursive: true, force: true });
    },
  };
}
