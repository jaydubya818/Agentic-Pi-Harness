import { describe, it, expect } from "vitest";
import { classifyEffect, semanticDecisionHash, semanticDrift } from "../../src/policy/semanticHash.js";
import { PolicyDecision } from "../../src/schemas/index.js";

function decision(toolCallId: string, result: "approve" | "deny" | "ask", winningRuleId: string | null): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId,
    result,
    provenanceMode: "full",
    matchedRuleIds: winningRuleId ? [winningRuleId] : [],
    winningRuleId,
    evaluationOrder: [],
    modeInfluence: "assist",
    manifestInfluence: null,
    hookInfluence: null,
    at: "2026-04-08T00:00:00Z",
  };
}

describe("semantic decision hash", () => {
  it("classifies by tool name prefix", () => {
    expect(classifyEffect("read_file", { path: "/etc" })).toBe("read-path");
    expect(classifyEffect("write_file", { path: "/tmp" })).toBe("write-path");
    expect(classifyEffect("bash", { cmd: "ls" })).toBe("exec");
    expect(classifyEffect("http_get", { url: "https://x" })).toBe("net");
    expect(classifyEffect("custom", {})).toBe("other");
  });

  it("falls back to input shape", () => {
    expect(classifyEffect("x", { url: "https://x" })).toBe("net");
    expect(classifyEffect("x", { cmd: "ls" })).toBe("exec");
    expect(classifyEffect("x", { path: "/a" })).toBe("read-path");
    expect(classifyEffect("x", { path: "/a", content: "c" })).toBe("write-path");
  });

  it("same {result, tool, class} -> same hash regardless of winningRuleId", () => {
    const a = decision("1", "deny", "old-rule-id");
    const b = decision("1", "deny", "renamed-rule-id");
    expect(semanticDecisionHash(a, "read_file", { path: "/etc/passwd" }))
      .toBe(semanticDecisionHash(b, "read_file", { path: "/etc/passwd" }));
  });

  it("different result -> different hash", () => {
    const a = decision("1", "deny", "r");
    const b = decision("1", "approve", "r");
    expect(semanticDecisionHash(a, "read_file", { path: "/etc" }))
      .not.toBe(semanticDecisionHash(b, "read_file", { path: "/etc" }));
  });

  it("semanticDrift returns only ids whose semantics changed", () => {
    const runA = [
      { decision: decision("1", "deny", "old-a"),   toolName: "read_file",  input: { path: "/etc/p" } },
      { decision: decision("2", "approve", "old-b"), toolName: "write_file", input: { path: "./src/x" } },
    ];
    const runB = [
      { decision: decision("1", "deny", "new-a"),   toolName: "read_file",  input: { path: "/etc/p" } },   // same semantics
      { decision: decision("2", "deny", "new-b"),    toolName: "write_file", input: { path: "./src/x" } },  // flipped
    ];
    expect(semanticDrift(runA, runB)).toEqual(["2"]);
  });
});
