import { describe, expect, it } from "vitest";
import {
  applyApprovalDecision,
  approvalRequiredByForDecision,
  createApprovalPacket,
  requestApprovalDecision,
} from "../../src/approvals/runtime.js";
import { PolicyDecision } from "../../src/schemas/index.js";

function askDecision(): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId: "t1",
    result: "ask",
    provenanceMode: "real",
    modeInfluence: "assist",
    manifestInfluence: null,
    ruleEvaluation: [{ scope: "project", ruleId: "ask-write", matched: true, effect: "deny" }],
    evaluationOrder: ["ask-write"],
    winningRuleId: "ask-write",
    hookDecision: null,
    mutatedByHook: false,
    approvalRequiredBy: null,
    policyDigest: "sha256:policy",
    at: "2026-04-10T00:00:00Z",
  };
}

describe("approval runtime", () => {
  it("creates deterministic approval packets", () => {
    const packet = createApprovalPacket({
      sessionId: "s1",
      decision: askDecision(),
      toolName: "write_file",
      timeoutMs: 50,
      requestedAt: "2026-04-10T00:00:01Z",
    });

    expect(packet).toEqual({
      packetId: "t1:approval",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "write_file",
      requestedAt: "2026-04-10T00:00:01Z",
      approvalRequiredBy: "rule",
      timeoutMs: 50,
      reason: "approval required by rule ask-write",
    });
    expect(approvalRequiredByForDecision(askDecision())).toBe("rule");
  });

  it("resolves approve, deny, and timeout decisions deterministically", async () => {
    const packet = createApprovalPacket({ sessionId: "s1", decision: askDecision(), toolName: "write_file", timeoutMs: 10, requestedAt: "2026-04-10T00:00:01Z" });

    await expect(requestApprovalDecision({
      packet,
      requester: { request: async () => ({ outcome: "approve", actor: "human", reason: "ok" }) },
      timeoutMs: 10,
      decidedAt: () => "2026-04-10T00:00:02Z",
    })).resolves.toEqual({
      packetId: "t1:approval",
      toolCallId: "t1",
      outcome: "approve",
      actor: "human",
      reason: "ok",
      decidedAt: "2026-04-10T00:00:02Z",
    });

    await expect(requestApprovalDecision({
      packet,
      requester: { request: async () => ({ outcome: "deny", actor: "human", reason: "no" }) },
      timeoutMs: 10,
      decidedAt: () => "2026-04-10T00:00:03Z",
    })).resolves.toEqual({
      packetId: "t1:approval",
      toolCallId: "t1",
      outcome: "deny",
      actor: "human",
      reason: "no",
      decidedAt: "2026-04-10T00:00:03Z",
    });

    await expect(requestApprovalDecision({
      packet,
      requester: undefined,
      timeoutMs: 10,
      decidedAt: () => "2026-04-10T00:00:04Z",
    })).resolves.toEqual({
      packetId: "t1:approval",
      toolCallId: "t1",
      outcome: "timeout",
      actor: "system",
      reason: "no approval requester configured",
      decidedAt: "2026-04-10T00:00:04Z",
    });
  });

  it("mediates ask decisions into final approve/deny outcomes", () => {
    const approved = applyApprovalDecision(askDecision(), {
      packetId: "t1:approval",
      toolCallId: "t1",
      outcome: "approve",
      actor: "human",
      decidedAt: "2026-04-10T00:00:02Z",
    });
    const denied = applyApprovalDecision(askDecision(), {
      packetId: "t1:approval",
      toolCallId: "t1",
      outcome: "timeout",
      actor: "system",
      decidedAt: "2026-04-10T00:00:03Z",
      reason: "approval timeout",
    });

    expect(approved.result).toBe("approve");
    expect(approved.approvalRequiredBy).toBe("rule");
    expect(approved.ruleEvaluation[0].effect).toBe("allow");
    expect(denied.result).toBe("deny");
    expect(denied.approvalRequiredBy).toBe("rule");
    expect(denied.ruleEvaluation[0].effect).toBe("deny");
  });
});
