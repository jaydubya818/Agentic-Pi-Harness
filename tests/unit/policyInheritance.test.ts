import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDoc, resolveRules } from "../../src/policy/engine.js";
import { PiHarnessError } from "../../src/errors.js";

const base: PolicyDoc = {
  schemaVersion: 1,
  default: "approve",
  rules: [
    { id: "deny-writes", match: { tool: "write_*" }, action: "deny", reason: "parent" },
    { id: "deny-writes-src", extends: "deny-writes", match: { pathPrefix: "/src/" } },
  ],
};

describe("PolicyEngine rule inheritance", () => {
  it("child inherits match.tool + action from parent, adds pathPrefix", () => {
    const resolved = resolveRules(base.rules);
    const child = resolved.find((r) => r.id === "deny-writes-src")!;
    expect(child.match.tool).toBe("write_*");
    expect(child.match.pathPrefix).toBe("/src/");
    expect(child.action).toBe("deny");
    expect(child.inheritedFrom).toEqual(["deny-writes"]);
  });

  it("inherited rule fires on match", () => {
    const eng = new PolicyEngine(base);
    const d = eng.decide({
      toolCallId: "t1", toolName: "write_file", mode: "assist",
      input: { path: "/src/index.ts", content: "x" },
    });
    expect(d.result).toBe("deny");
    expect(d.matchedRuleIds).toContain("deny-writes");
    expect(d.matchedRuleIds).toContain("deny-writes-src");
  });

  it("child can override parent action", () => {
    const doc: PolicyDoc = {
      schemaVersion: 1,
      default: "approve",
      rules: [
        { id: "a", match: { tool: "read_*" }, action: "deny" },
        { id: "b", extends: "a", action: "approve" },
      ],
    };
    const eng = new PolicyEngine(doc);
    // both a and b match read_file; b wins for its own decide only if it comes first.
    // Here a is first, so a wins. Verify resolution independently:
    expect(eng.getResolvedRules().find((r) => r.id === "b")!.action).toBe("approve");
  });

  it("detects inheritance cycles as E_POLICY_CYCLE", () => {
    const doc: PolicyDoc = {
      schemaVersion: 1,
      default: "approve",
      rules: [
        { id: "x", extends: "y", action: "deny" },
        { id: "y", extends: "x", action: "approve" },
      ],
    };
    expect(() => new PolicyEngine(doc)).toThrow(PiHarnessError);
  });
});
