import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree } from "../../src/subagents/worktree.js";

const pexec = promisify(execFile);

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wt-repo-"));
  await pexec("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await pexec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await pexec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "original\n");
  await pexec("git", ["-C", dir, "add", "."]);
  await pexec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

describe("sub-agent worktree isolation", () => {
  it("sub-agent writes do not affect the main worktree until merge", async () => {
    const repo = await initRepo();
    const wt = await createWorktree(repo, "child");
    try {
      // Mutate inside the worktree
      await writeFile(join(wt.path, "a.txt"), "mutated\n");
      await writeFile(join(wt.path, "new.txt"), "added\n");

      // Main repo is untouched
      const main = await readFile(join(repo, "a.txt"), "utf8");
      expect(main).toBe("original\n");
      await expect(readFile(join(repo, "new.txt"), "utf8")).rejects.toThrow();

      // Worktree sees its own copy
      expect(await readFile(join(wt.path, "a.txt"), "utf8")).toBe("mutated\n");
      expect(wt.branch).toMatch(/^pi\/child-/);
    } finally {
      await wt.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("dispose cleans up the worktree directory and branch", async () => {
    const repo = await initRepo();
    const wt = await createWorktree(repo, "cleanup");
    await wt.dispose();
    await expect(readFile(join(wt.path, "a.txt"), "utf8")).rejects.toThrow();
    const { stdout } = await pexec("git", ["-C", repo, "branch", "--list", wt.branch]);
    expect(stdout.trim()).toBe("");
    await rm(repo, { recursive: true, force: true });
  });
});
