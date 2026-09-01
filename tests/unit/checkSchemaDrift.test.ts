import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("scripts/check-schema-drift.mjs");

/**
 * `scripts/check-schema-drift.mjs` is the other half of `.husky/pre-commit`
 * (alongside the staged-secret guard, which `checkSecrets.test.ts` covers)
 * and `docs/SCHEMAS.md` names it as the mechanism that keeps the Tier A
 * schema contract and its documentation in step. It had no test.
 *
 * The guard reads `git diff --cached`, so these cases drive it against a
 * throwaway repository with a real index rather than calling into it.
 */
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function stage(cwd: string, path: string, contents = "x\n"): Promise<void> {
  const full = join(cwd, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  await git(cwd, ["add", "--", path]);
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-schema-drift-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["config", "user.email", "t@example.com"]);
  return dir;
}

async function run(cwd: string): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [SCRIPT], { cwd });
    return { code: 0, stderr: "" };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("schema-drift guard (scripts/check-schema-drift.mjs)", () => {
  it("refuses a schema change with no docs/SCHEMAS.md in the same commit", async () => {
    const dir = await repo();
    await stage(dir, "src/schemas/effectRecord.ts");

    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("files under src/schemas/ changed but docs/SCHEMAS.md did not");
  });

  it("allows the same change once docs/SCHEMAS.md is staged too", async () => {
    const dir = await repo();
    await stage(dir, "src/schemas/effectRecord.ts");
    await stage(dir, "docs/SCHEMAS.md", "# Schemas\n");

    expect((await run(dir)).code).toBe(0);
  });

  it("stays out of the way when nothing, or nothing schema-shaped, is staged", async () => {
    const empty = await repo();
    expect((await run(empty)).code).toBe(0);

    const unrelated = await repo();
    await stage(unrelated, "src/loop/query.ts");
    await stage(unrelated, "README.md");
    expect((await run(unrelated)).code).toBe(0);
  });

  it("fires on a deleted schema module, not only an edited one", async () => {
    // `git diff --cached --name-only` carries no --diff-filter, so a staged
    // deletion is a staged change. Worth pinning: removing a schema is the
    // change most likely to leave docs/SCHEMAS.md describing something that
    // no longer exists.
    const dir = await repo();
    await stage(dir, "src/schemas/sessionContext.ts");
    await stage(dir, "docs/SCHEMAS.md", "# Schemas\n");
    await git(dir, ["commit", "-q", "-m", "seed"]);

    await git(dir, ["rm", "-q", "--", "src/schemas/sessionContext.ts"]);
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("docs/SCHEMAS.md did not");
  });

  it("only watches .ts files, so a non-TypeScript file under src/schemas/ passes", async () => {
    // Characterization of the `.endsWith(".ts")` narrowing. Nothing under
    // src/schemas/ is anything but TypeScript today, so this is the current
    // boundary rather than a hole -- pinned so a future fixture or JSON
    // artifact added there is a deliberate decision.
    const dir = await repo();
    await stage(dir, "src/schemas/fixture.json", "{}\n");

    expect((await run(dir)).code).toBe(0);
  });

  it("is content-blind: any staged edit to docs/SCHEMAS.md satisfies it", async () => {
    // The script's own docstring calls this "blunt but effective". Pinned so
    // the tradeoff is visible: the guard forces the two files to move
    // together, it does not check that the doc change describes the schema
    // change.
    const dir = await repo();
    await stage(dir, "docs/SCHEMAS.md", "# Schemas\n");
    await git(dir, ["commit", "-q", "-m", "seed"]);

    await stage(dir, "src/schemas/tapeRecord.ts");
    await stage(dir, "docs/SCHEMAS.md", "# Schemas\n\n<!-- unrelated typo fix -->\n");

    expect((await run(dir)).code).toBe(0);
  });
});
