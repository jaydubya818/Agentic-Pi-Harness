import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPolicyDecision,
  placeholderApprove,
  readPolicyLog,
  renderPolicyInspection,
} from "../../src/policy/decision.js";
import { evaluatePolicyDecision, PolicyDoc } from "../../src/policy/engine.js";

describe("policy decision contract", () => {
  it("creates a full-shape placeholder decision with propagated policyDigest", () => {
    const decision = placeholderApprove({
      toolCallId: "tool-1",
      modeInfluence: "assist",
      policyDigest: "sha256:policy-test",
      at: "2026-04-08T00:00:00Z",
    });

    expect(decision).toEqual({
      schemaVersion: 1,
      toolCallId: "tool-1",
      result: "approve",
      provenanceMode: "placeholder",
      modeInfluence: "assist",
      manifestInfluence: null,
      ruleEvaluation: [],
      evaluationOrder: [],
      winningRuleId: null,
      hookDecision: null,
      mutatedByHook: false,
      approvalRequiredBy: null,
      policyDigest: "sha256:policy-test",
      at: "2026-04-08T00:00:00Z",
    });
  });

  it("writes, reads, and renders mixed placeholder + real decisions for inspect --policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-policy-log-"));
    const path = join(dir, "policy.jsonl");
    const placeholder = placeholderApprove({
      toolCallId: "tool-1",
      modeInfluence: "assist",
      policyDigest: "sha256:policy-test",
      at: "2026-04-08T00:00:00Z",
    });
    const doc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "deny",
      rules: [{ id: "allow-read", action: "approve", match: { tool: "read_file" } }],
    };
    const real = {
      ...evaluatePolicyDecision(doc, {
        toolCallId: "tool-2",
        toolName: "read_file",
        mode: "assist",
        input: { path: "tests/math.test.ts" },
        policyDigest: "sha256:policy-test",
        at: "2026-04-08T00:00:01Z",
      }),
      result: "deny" as const,
      approvalRequiredBy: "rule" as const,
      manifestInfluence: { field: "workerControl", value: "writePathPrefix" },
      hookDecision: { hookId: "blocker", decision: "deny", reason: "review-required" },
    };

    await appendPolicyDecision(path, placeholder);
    await appendPolicyDecision(path, real);
    const decisions = await readPolicyLog(path);
    expect(decisions).toEqual([placeholder, real]);

    const rendered = renderPolicyInspection(decisions);
    expect(rendered).toContain("tool-1 approve provenance=placeholder");
    expect(rendered).toContain("tool-2 deny provenance=real");
    expect(rendered).toContain("winningRule=allow-read");
    expect(rendered).toContain("hookDecision=deny@blocker:review-required");
    expect(rendered).toContain("approvalRequiredBy=rule");
    expect(rendered).toContain("manifestInfluence=workerControl:writePathPrefix");
    expect(rendered).toContain("policyDigest=sha256:policy-test");
    expect(rendered).toContain("mode=assist");
  });

  it("fails closed on schema-invalid policy log entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-policy-log-invalid-"));
    const path = join(dir, "policy.jsonl");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, toolCallId: "missing" }) + "\n", "utf8");

    await expect(readPolicyLog(path)).rejects.toMatchObject({
      name: "PiHarnessError",
      code: "E_SCHEMA_PARSE",
    });
  });
});
