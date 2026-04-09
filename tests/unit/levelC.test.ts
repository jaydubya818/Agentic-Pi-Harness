import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffDecisionLogs } from "../../src/replay/levelC.js";
import { PolicyDecision } from "../../src/schemas/index.js";

const mk = (id: string, result: "approve" | "deny" | "ask", ruleId: string | null): PolicyDecision => ({
  schemaVersion: 1,
  toolCallId: id,
  result,
  provenanceMode: "full",
  modeInfluence: "assist",
  manifestInfluence: null,
  ruleEvaluation: ruleId ? [{ scope: "project", ruleId, matched: true, effect: result === "approve" ? "allow" : "deny" }] : [],
  evaluationOrder: ["r1", "r2"],
  winningRuleId: ruleId,
  hookDecision: null,
  mutatedByHook: false,
  approvalRequiredBy: result === "ask" ? "rule" : null,
  policyDigest: "sha256:policy-test",
  at: "2026-04-08T00:00:00Z",
});

async function tmpLog(ds: PolicyDecision[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lc-"));
  const p = join(dir, "policy.jsonl");
  await writeFile(p, ds.map((d) => JSON.stringify(d)).join("\n") + "\n");
  return p;
}

describe("level-C decision drift", () => {
  it("matches identical logs ignoring timestamp", async () => {
    const a = await tmpLog([mk("t1", "approve", "r1"), mk("t2", "deny", "r2")]);
    const b = await tmpLog([mk("t1", "approve", "r1"), mk("t2", "deny", "r2")]);
    expect((await diffDecisionLogs(a, b)).ok).toBe(true);
  });

  it("flags result mismatch", async () => {
    const a = await tmpLog([mk("t1", "approve", "r1")]);
    const b = await tmpLog([mk("t1", "deny", "r1")]);
    const d = await diffDecisionLogs(a, b);
    expect(d.ok).toBe(false);
    expect(d.resultMismatches).toHaveLength(1);
  });

  it("flags winning-rule drift", async () => {
    const a = await tmpLog([mk("t1", "approve", "r1")]);
    const b = await tmpLog([mk("t1", "approve", "r2")]);
    const d = await diffDecisionLogs(a, b);
    expect(d.ok).toBe(false);
    expect(d.ruleMismatches).toHaveLength(1);
  });
});
