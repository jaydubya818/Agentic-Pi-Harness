import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decidePolicy } from "../../src/policy/decision.js";
import { evaluatePolicyDecision, PolicyDocSchema, PolicyEngine } from "../../src/policy/engine.js";

type FixtureDecisionInput = {
  toolCallId: string;
  toolName: string;
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  input: unknown;
  policyDigest?: string;
};

type PolicyFixture = {
  policyMode: "placeholder" | "real";
  policy: unknown;
  cases: Array<{
    name: string;
    decisionInput: FixtureDecisionInput;
    expected: {
      result: "approve" | "deny" | "ask";
      provenanceMode: "placeholder" | "real";
      winningRuleId: string | null;
      evaluationOrder: string[];
    };
  }>;
};

async function loadFixture(name: string): Promise<PolicyFixture> {
  const path = join(process.cwd(), "tests", "fixtures", "policy", name);
  return JSON.parse(await readFile(path, "utf8")) as PolicyFixture;
}

describe("policy evaluator fixtures", () => {
  const files = [
    "00-placeholder-baseline.json",
    "10-assist-read-write-default-allow.json",
    "20-deny-writes-plan-mode.json",
    "30-path-scoped-write-policy.json",
    "40-default-deny-unknown-tool.json",
    "50-precedence-first-match-wins.json",
  ];

  for (const file of files) {
    it(`matches fixture ${file}`, async () => {
      const fixture = await loadFixture(file);
      const policy = fixture.policy ? PolicyDocSchema.parse(fixture.policy) : null;

      for (const testCase of fixture.cases) {
        const decision = fixture.policyMode === "placeholder"
          ? decidePolicy({
              policyMode: fixture.policyMode,
              toolCallId: testCase.decisionInput.toolCallId,
              toolName: testCase.decisionInput.toolName,
              mode: testCase.decisionInput.mode,
              input: testCase.decisionInput.input,
              policyDigest: testCase.decisionInput.policyDigest,
            })
          : evaluatePolicyDecision(policy!, {
              ...testCase.decisionInput,
              at: "2026-04-09T00:00:00Z",
            });

        expect(decision.result, testCase.name).toBe(testCase.expected.result);
        expect(decision.provenanceMode, testCase.name).toBe(testCase.expected.provenanceMode);
        expect(decision.winningRuleId, testCase.name).toBe(testCase.expected.winningRuleId);
        expect(decision.evaluationOrder, testCase.name).toEqual(testCase.expected.evaluationOrder);
      }
    });
  }

  it("evaluatePolicyDecision is deterministic for identical inputs", async () => {
    const fixture = await loadFixture("50-precedence-first-match-wins.json");
    const policy = PolicyDocSchema.parse(fixture.policy);
    const input = {
      ...fixture.cases[0].decisionInput,
      at: "2026-04-09T00:00:00Z",
    };

    expect(evaluatePolicyDecision(policy, input)).toEqual(evaluatePolicyDecision(policy, input));
  });

  it("defaults to placeholder mode unless real mode is explicitly selected", async () => {
    const fixture = await loadFixture("40-default-deny-unknown-tool.json");
    const policy = new PolicyEngine(PolicyDocSchema.parse(fixture.policy));
    const input = fixture.cases[1].decisionInput;

    const placeholder = decidePolicy({
      policy,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      mode: input.mode,
      input: input.input,
      policyDigest: input.policyDigest,
    });

    const real = decidePolicy({
      policyMode: "real",
      policy,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      mode: input.mode,
      input: input.input,
      policyDigest: input.policyDigest,
    });

    expect(placeholder.provenanceMode).toBe("placeholder");
    expect(placeholder.result).toBe("approve");
    expect(real.provenanceMode).toBe("real");
    expect(real.result).toBe("deny");
  });
});
