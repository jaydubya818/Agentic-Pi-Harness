import { describe, expect, it } from "vitest";
import { dispatchPostToolHooks, dispatchPreToolHooks, mergeHookDeniedDecision, RegisteredToolHook } from "../../src/hooks/mediation.js";
import { PolicyDecision } from "../../src/schemas/index.js";

function baseDecision(provenanceMode: "placeholder" | "real" = "real"): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId: "tool-1",
    result: "approve",
    provenanceMode,
    modeInfluence: "assist",
    manifestInfluence: null,
    ruleEvaluation: [{ scope: "project", ruleId: "allow-read", matched: true, effect: "allow" }],
    evaluationOrder: ["allow-read"],
    winningRuleId: "allow-read",
    hookDecision: null,
    mutatedByHook: false,
    approvalRequiredBy: null,
    policyDigest: "sha256:policy-test",
    at: "2026-04-09T00:00:00Z",
  };
}

describe("hook mediation helpers", () => {
  it("mergeHookDeniedDecision layers hook denial over existing policy provenance", () => {
    const mergedReal = mergeHookDeniedDecision(baseDecision("real"), {
      hookId: "hook-1",
      decision: "deny",
      reason: "blocked",
    });
    const mergedPlaceholder = mergeHookDeniedDecision(baseDecision("placeholder"), {
      hookId: "hook-2",
      decision: "deny",
    });

    expect(mergedReal.result).toBe("deny");
    expect(mergedReal.provenanceMode).toBe("real");
    expect(mergedReal.winningRuleId).toBe("allow-read");
    expect(mergedReal.hookDecision).toEqual({ hookId: "hook-1", decision: "deny", reason: "blocked" });
    expect(mergedReal.mutatedByHook).toBe(false);
    expect(mergedReal.approvalRequiredBy).toBeNull();

    expect(mergedPlaceholder.result).toBe("deny");
    expect(mergedPlaceholder.provenanceMode).toBe("placeholder");
    expect(mergedPlaceholder.hookDecision).toEqual({ hookId: "hook-2", decision: "deny" });
  });

  it("dispatches pre hooks in registration order and stops on first deny", async () => {
    const order: string[] = [];
    const hooks: RegisteredToolHook[] = [
      { hookId: "a", event: "PreToolUse", timeoutMs: 100, fn: () => { order.push("a"); return { outcome: "continue" }; } },
      { hookId: "b", event: "PreToolUse", timeoutMs: 100, fn: () => { order.push("b"); return { outcome: "deny", reason: "nope" }; } },
      { hookId: "c", event: "PreToolUse", timeoutMs: 100, fn: () => { order.push("c"); return { outcome: "continue" }; } },
    ];

    const result = await dispatchPreToolHooks(hooks, {
      event: "PreToolUse",
      sessionId: "s1",
      turnIndex: 0,
      payload: {
        toolCallId: "tool-1",
        toolName: "read_file",
        mode: "assist",
        input: { path: "tests/math.test.ts" },
        baseDecision: { result: "approve", provenanceMode: "real", winningRuleId: "allow-read" },
      },
    });

    expect(order).toEqual(["a", "b"]);
    expect(result.deniedBy).toEqual({ hookId: "b", decision: "deny", reason: "nope" });
    expect(result.summaries.map((summary) => summary.status)).toEqual(["continue", "deny"]);
  });

  it("treats modify as invalid for pre hooks and continues", async () => {
    const result = await dispatchPreToolHooks([
      { hookId: "bad", event: "PreToolUse", timeoutMs: 100, fn: () => ({ outcome: "modify", patch: {} }) },
      { hookId: "good", event: "PreToolUse", timeoutMs: 100, fn: () => ({ outcome: "continue" }) },
    ], {
      event: "PreToolUse",
      sessionId: "s1",
      turnIndex: 0,
      payload: {
        toolCallId: "tool-1",
        toolName: "read_file",
        mode: "assist",
        input: { path: "tests/math.test.ts" },
        baseDecision: { result: "approve", provenanceMode: "placeholder", winningRuleId: null },
      },
    });

    expect(result.deniedBy).toBeNull();
    expect(result.summaries.map((summary) => summary.status)).toEqual(["invalid", "continue"]);
  });

  it("treats deny as invalid for post hooks and leaves only runtime summaries", async () => {
    const result = await dispatchPostToolHooks([
      { hookId: "deny-post", event: "PostToolUse", timeoutMs: 100, fn: () => ({ outcome: "deny", reason: "too late" }) },
      { hookId: "continue-post", event: "PostToolUse", timeoutMs: 100, fn: () => ({ outcome: "continue" }) },
    ], {
      event: "PostToolUse",
      sessionId: "s1",
      turnIndex: 0,
      payload: {
        toolCallId: "tool-1",
        toolName: "read_file",
        mode: "assist",
        input: { path: "tests/math.test.ts" },
        isError: false,
        paths: ["tests/math.test.ts"],
      },
    });

    expect(result.summaries.map((summary) => summary.status)).toEqual(["invalid", "continue"]);
  });
});
