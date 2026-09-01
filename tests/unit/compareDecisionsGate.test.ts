import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PolicyDecision } from "../../src/schemas/index.js";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("scripts/compare-decisions.mjs");

/**
 * `scripts/compare-decisions.mjs` runs twice in the `golden-proof` job of
 * `.github/workflows/ci.yml` — once exact, once `--semantic` — and had no
 * test. These cases are characterization. In particular they pin the
 * asymmetry recorded in `docs/NIGHTLY-BACKLOG.md` (2026-08-28): `--semantic`
 * is strictly weaker than the default mode, not orthogonal to it, because a
 * `PolicyDecision` carries no `toolName` and no `input`. If the decision
 * record ever gains tool identity, the two `--semantic` cases below start
 * failing, which is the signal that the gate has become load-bearing.
 */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId: "t1",
    result: "approve",
    provenanceMode: "placeholder",
    modeInfluence: "assist",
    manifestInfluence: null,
    ruleEvaluation: [],
    evaluationOrder: [],
    winningRuleId: "allow-reads",
    hookDecision: null,
    mutatedByHook: false,
    approvalRequiredBy: null,
    policyDigest: "sha256:policy",
    at: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

async function writeLog(dir: string, name: string, records: PolicyDecision[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

describe("Level C decision-drift gate (scripts/compare-decisions.mjs)", () => {
  it("accepts identical logs in both modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const b = await writeLog(dir, "b.jsonl", [decision()]);

    const exact = await run([a, b]);
    expect(exact.code).toBe(0);
    expect(exact.stdout).toContain("decisions match: 1 records (exact)");

    const semantic = await run(["--semantic", a, b]);
    expect(semantic.code).toBe(0);
    expect(semantic.stdout).toContain("decisions match: 1 records (semantic)");
  });

  it("rejects a changed result in both modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const b = await writeLog(dir, "b.jsonl", [decision({ result: "deny" })]);

    expect((await run([a, b])).code).toBe(1);
    expect((await run(["--semantic", a, b])).code).toBe(1);
  });

  it("exact mode rejects a changed winningRuleId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const b = await writeLog(dir, "b.jsonl", [decision({ winningRuleId: "allow-everything" })]);

    const exact = await run([a, b]);
    expect(exact.code).toBe(1);
    expect(exact.stderr).toContain("drift: 1 decision(s) diverge: t1");
  });

  it("semantic mode accepts the winningRuleId change that exact mode rejects", async () => {
    // Not a bug being introduced here — this is the state of the gate as
    // documented in the script header and in the backlog. `--semantic`
    // reduces to {result}, so it can never fail a comparison the exact pass
    // accepted, and two calls approved by entirely different rules "match".
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const b = await writeLog(dir, "b.jsonl", [decision({ winningRuleId: "allow-everything" })]);

    const semantic = await run(["--semantic", a, b]);
    expect(semantic.code).toBe(0);
    expect(semantic.stdout).toContain("decisions match: 1 records (semantic)");
  });

  it("semantic mode also ignores provenanceMode, which exact mode does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const b = await writeLog(dir, "b.jsonl", [decision({ provenanceMode: "real" })]);

    expect((await run([a, b])).code).toBe(1);
    expect((await run(["--semantic", a, b])).code).toBe(0);
  });

  it("rejects a differing record count in both modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision(), decision({ toolCallId: "t2" })]);
    const b = await writeLog(dir, "b.jsonl", [decision()]);

    const exact = await run([a, b]);
    expect(exact.code).toBe(1);
    expect(exact.stderr).toContain("drift: record count 2 vs 1");
    expect((await run(["--semantic", a, b])).code).toBe(1);
  });

  it("compares positionally, so reordering two decisions is drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const first = decision({ toolCallId: "t1", winningRuleId: "allow-reads" });
    const second = decision({ toolCallId: "t2", winningRuleId: "deny-writes", result: "deny" });
    const a = await writeLog(dir, "a.jsonl", [first, second]);
    const b = await writeLog(dir, "b.jsonl", [second, first]);

    expect((await run([a, b])).code).toBe(1);
  });

  it("exits 2 on a missing argument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);

    const result = await run(["--semantic", a]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: compare-decisions.mjs");
  });

  it("fails rather than passing when a log line is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-dec-"));
    const a = await writeLog(dir, "a.jsonl", [decision()]);
    const torn = join(dir, "torn.jsonl");
    await writeFile(torn, JSON.stringify(decision()).slice(0, 40) + "\n", "utf8");

    expect((await run([a, torn])).code).not.toBe(0);
  });
});
