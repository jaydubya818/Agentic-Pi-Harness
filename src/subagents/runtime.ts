import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorktree, Worktree } from "./worktree.js";

export interface ParentSessionBoundary {
  sessionId: string;
  repoRoot: string;
  outRoot: string;
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
}

export interface SubagentTaskContext {
  childId: string;
  artifactDir: string;
  mode: ParentSessionBoundary["mode"];
  worktree: Worktree;
  signal: AbortSignal;
}

export interface SubagentRunResult<T> {
  childId: string;
  artifactDir: string;
  branch: string;
  status: "completed" | "cancelled" | "failed";
  value: T | null;
  error?: string;
}

export interface RunSubagentTaskInput<T> {
  parent: ParentSessionBoundary;
  order: number;
  slug: string;
  signal?: AbortSignal;
  run(context: SubagentTaskContext): Promise<T>;
}

export function createChildSessionId(parentSessionId: string, order: number, slug: string): string {
  return `${parentSessionId}:child:${order}:${slug}`;
}

export function childArtifactDir(parent: ParentSessionBoundary, childId: string): string {
  return join(parent.outRoot, "sessions", parent.sessionId, "children", childId);
}

export async function runSubagentTask<T>(input: RunSubagentTaskInput<T>): Promise<SubagentRunResult<T>> {
  const signal = input.signal ?? new AbortController().signal;
  const childId = createChildSessionId(input.parent.sessionId, input.order, input.slug);
  const artifactDir = childArtifactDir(input.parent, childId);
  await mkdir(artifactDir, { recursive: true });

  const worktree = await createWorktree(input.parent.repoRoot, `${input.slug}-${input.order}`);
  try {
    if (signal.aborted) {
      return { childId, artifactDir, branch: worktree.branch, status: "cancelled", value: null };
    }

    const value = await input.run({
      childId,
      artifactDir,
      mode: input.parent.mode,
      worktree,
      signal,
    });

    if (signal.aborted) {
      return { childId, artifactDir, branch: worktree.branch, status: "cancelled", value: null };
    }

    return {
      childId,
      artifactDir,
      branch: worktree.branch,
      status: "completed",
      value,
    };
  } catch (error) {
    if (signal.aborted) {
      return { childId, artifactDir, branch: worktree.branch, status: "cancelled", value: null };
    }
    return {
      childId,
      artifactDir,
      branch: worktree.branch,
      status: "failed",
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await worktree.dispose();
  }
}

export async function runSubagentTasksSequentially<T>(tasks: RunSubagentTaskInput<T>[]): Promise<SubagentRunResult<T>[]> {
  const results: SubagentRunResult<T>[] = [];
  for (const task of tasks) {
    results.push(await runSubagentTask(task));
  }
  return results;
}
