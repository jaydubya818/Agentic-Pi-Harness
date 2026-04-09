import { describe, expect, it } from "vitest";
import { answerRoutineQuestion, decideSofieEscalation, detectScopeDrift } from "../../src/sofie/authority.js";

describe("Sofie authority", () => {
  it("answers routine review and closure questions without human escalation", () => {
    const answer = answerRoutineQuestion({
      sessionId: "s1",
      mode: "assist",
      question: "Can we close this bounded validation pass?",
      kind: "closure",
      effects: [{
        schemaVersion: 1,
        toolCallId: "t1",
        sessionId: "s1",
        toolName: "write_file",
        paths: ["/tmp/a.txt"],
        preHashes: { "/tmp/a.txt": "sha256:a" },
        postHashes: { "/tmp/a.txt": "sha256:b" },
        unifiedDiff: "diff",
        binaryChanged: false,
        timestamp: "2026-04-09T00:00:00.000Z",
      }],
      decisions: [{
        schemaVersion: 1,
        toolCallId: "t1",
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
        policyDigest: "sha256:policy",
        at: "2026-04-09T00:00:00.000Z",
      }],
    });

    expect(answer.escalation.escalate).toBe(false);
    expect(answer.closureRecommendation).toBe("complete");
    expect(answer.summary).toContain("closure");
  });

  it("escalates only on true blocker categories", () => {
    const escalation = decideSofieEscalation({
      sessionId: "s1",
      mode: "assist",
      question: "Should we change the canonical golden tape?",
      kind: "review",
    });

    expect(escalation.escalate).toBe(true);
    expect(escalation.reason).toBe("frozen_contract_change");
  });

  it("uses real tool identity evidence for destructive-action escalation", () => {
    const escalation = decideSofieEscalation({
      sessionId: "s1",
      mode: "assist",
      question: "Review destructive attempt status",
      kind: "review",
      toolEvidence: [{ toolName: "deploy", toolCallId: "t9", result: "deny" }],
    });

    expect(escalation.escalate).toBe(true);
    expect(escalation.reason).toBe("destructive_outside_policy");
  });

  it("detects scope drift for frozen and out-of-scope areas", () => {
    expect(detectScopeDrift({
      sessionId: "s1",
      mode: "assist",
      question: "Please add Mission Control UI and change artifact filenames",
      kind: "scope",
    })).toBe(true);
  });
});
