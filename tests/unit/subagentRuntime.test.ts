import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  childArtifactDir,
  createChildSessionId,
  runSubagentTask,
  runSubagentTasksSequentially,
} from "../../src/subagents/runtime.js";

const pexec = promisify(execFile);

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
  await pexec("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await pexec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await pexec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "root\n", "utf8");
  await pexec("git", ["-C", dir, "add", "."]);
  await pexec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

describe("subagent runtime", () => {
  it("creates deterministic child ids and isolated artifact directories", async () => {
    const parent = { sessionId: "s1", repoRoot: "/repo", outRoot: "/out", mode: "assist" as const };
    expect(createChildSessionId(parent.sessionId, 0, "lint")).toBe("s1:child:0:lint");
    expect(childArtifactDir(parent, "s1:child:0:lint")).toBe(join("/out", "sessions", "s1", "children", "s1:child:0:lint"));
  });

  it("runs a child in an isolated worktree and cleans it up afterwards", async () => {
    const repoRoot = await initRepo();
    const outRoot = await mkdtemp(join(tmpdir(), "pi-subagent-out-"));
    const result = await runSubagentTask({
      parent: { sessionId: "s1", repoRoot, outRoot, mode: "assist" },
      order: 0,
      slug: "child",
      async run(context) {
        await writeFile(join(context.worktree.path, "a.txt"), "child\n", "utf8");
        await writeFile(join(context.artifactDir, "summary.txt"), "done\n", "utf8");
        return { worktreePath: context.worktree.path };
      },
    });

    expect(result.status).toBe("completed");
    expect(await readFile(join(repoRoot, "a.txt"), "utf8")).toBe("root\n");
    expect(await readFile(join(result.artifactDir, "summary.txt"), "utf8")).toBe("done\n");
    await expect(stat((result.value as { worktreePath: string }).worktreePath)).rejects.toThrow();

    await rm(repoRoot, { recursive: true, force: true });
    await rm(outRoot, { recursive: true, force: true });
  });

  it("treats aborted children as cancelled and coordinates sequentially in input order", async () => {
    const repoRoot = await initRepo();
    const outRoot = await mkdtemp(join(tmpdir(), "pi-subagent-seq-"));
    const order: string[] = [];
    const aborted = new AbortController();
    aborted.abort();

    const results = await runSubagentTasksSequentially([
      {
        parent: { sessionId: "s1", repoRoot, outRoot, mode: "worker" },
        order: 0,
        slug: "first",
        async run(context) {
          order.push(context.childId);
          return "first";
        },
      },
      {
        parent: { sessionId: "s1", repoRoot, outRoot, mode: "worker" },
        order: 1,
        slug: "second",
        signal: aborted.signal,
        async run() {
          order.push("should-not-run");
          return "second";
        },
      },
      {
        parent: { sessionId: "s1", repoRoot, outRoot, mode: "worker" },
        order: 2,
        slug: "third",
        async run(context) {
          order.push(context.childId);
          return "third";
        },
      },
    ]);

    expect(order).toEqual(["s1:child:0:first", "s1:child:2:third"]);
    expect(results.map((result) => result.status)).toEqual(["completed", "cancelled", "completed"]);

    await rm(repoRoot, { recursive: true, force: true });
    await rm(outRoot, { recursive: true, force: true });
  });
});
