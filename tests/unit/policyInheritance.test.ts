import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDoc, ruleMatches } from "../../src/policy/engine.js";

const precedenceDoc: PolicyDoc = {
  schemaVersion: 1,
  defaultAction: "deny",
  rules: [
    { id: "first-allow-tests-write", action: "approve", match: { tool: "write_file", pathPrefix: "tests/" } },
    { id: "second-deny-tests-write", action: "deny", match: { tool: "write_file", pathPrefix: "tests/" } },
  ],
};

describe("PolicyEngine precedence", () => {
  it("supports exact tool matching without globbing", () => {
    expect(ruleMatches(precedenceDoc.rules[0], {
      toolCallId: "t1",
      toolName: "write_file",
      mode: "assist",
      input: { path: "tests/math.test.ts" },
    })).toBe(true);

    expect(ruleMatches(precedenceDoc.rules[0], {
      toolCallId: "t2",
      toolName: "write_other",
      mode: "assist",
      input: { path: "tests/math.test.ts" },
    })).toBe(false);
  });

  it("first matching rule wins deterministically", () => {
    const eng = new PolicyEngine(precedenceDoc);
    const d = eng.decide({
      toolCallId: "t1",
      toolName: "write_file",
      mode: "assist",
      input: { path: "tests/math.test.ts", content: "patched" },
      at: "2026-04-09T00:00:00Z",
    });

    expect(d.result).toBe("approve");
    expect(d.winningRuleId).toBe("first-allow-tests-write");
    expect(d.evaluationOrder).toEqual(["first-allow-tests-write", "second-deny-tests-write"]);
  });
});
