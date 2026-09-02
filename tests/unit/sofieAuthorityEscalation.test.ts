import { describe, expect, it } from "vitest";
import {
  answerRoutineQuestion,
  decideSofieEscalation,
  detectDestructiveActionOutsidePolicy,
  detectInsufficientEvidence,
  makeApprovalSummaries,
  SofieContext,
} from "../../src/sofie/authority.js";
import { EffectRecord, PolicyDecision } from "../../src/schemas/index.js";

function context(overrides: Partial<SofieContext> = {}): SofieContext {
  return { sessionId: "s1", mode: "assist", question: "Status?", kind: "review", ...overrides };
}

function writeEffect(path: string): EffectRecord {
  return {
    schemaVersion: 1,
    toolCallId: `t-${path}`,
    sessionId: "s1",
    toolName: "write_file",
    paths: [path],
    preHashes: { [path]: "sha256:a" },
    postHashes: { [path]: "sha256:b" },
    unifiedDiff: "diff",
    binaryChanged: false,
    timestamp: "2026-04-09T00:00:00.000Z",
  };
}

function decision(result: PolicyDecision["result"]): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId: "t1",
    result,
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
  };
}

// Characterization: pins the escalation ladder as implemented so that a
// reorder or a widened marker list shows up as a failing test rather than
// as a silently different `reason` on a needs-human verdict.
describe("Sofie escalation precedence", () => {
  const ladder: Array<[SofieContext["question"], string]> = [
    ["wipe the leaked secrets from the pricing roadmap priority golden path", "destructive_outside_policy"],
    ["leaked secrets in the pricing roadmap priority golden path", "credentials_or_permissions"],
    ["pricing roadmap priority for the golden path", "ambiguous_business_decision"],
    ["golden path change", "frozen_contract_change"],
  ];

  it.each(ladder)("question %j resolves to %s when several detectors fire", (question, reason) => {
    const escalation = decideSofieEscalation(context({ question }));
    expect(escalation.escalate).toBe(true);
    expect(escalation.reason).toBe(reason);
  });

  it("falls through to insufficient_evidence only after every blocker detector passes", () => {
    const escalation = decideSofieEscalation(context({ question: "Can we close?", kind: "closure" }));
    expect(escalation).toMatchObject({ escalate: true, reason: "insufficient_evidence" });
  });

  it("frictionFindings feed the credential and scope-drift detectors but not the frozen-contract one", () => {
    // validate-target.ts forwards failed command stderr as frictionFindings,
    // so stderr text can select the escalation reason.
    expect(decideSofieEscalation(context({ question: "Review", frictionFindings: ["EACCES: permission denied"] })).reason)
      .toBe("credentials_or_permissions");
    expect(decideSofieEscalation(context({ question: "Review", frictionFindings: ["error TS2305: unrelated to the export"] })).reason)
      .toBe("frozen_contract_change");
    // "golden" alone is a frozen-contract marker for the question only; in a
    // finding it is not a scope-drift marker (only "goldens" is).
    expect(decideSofieEscalation(context({ question: "Review", frictionFindings: ["golden"], decisions: [decision("approve")] })).escalate)
      .toBe(false);
  });

  it("matches credential markers as substrings, so 'secretary' escalates", () => {
    expect(decideSofieEscalation(context({ question: "Review the secretary role page", decisions: [decision("approve")] })).reason)
      .toBe("credentials_or_permissions");
  });
});

describe("Sofie destructive-action detection", () => {
  it("treats a write into .git or node_modules as destructive, but not into a sibling name", () => {
    expect(detectDestructiveActionOutsidePolicy(context({ effects: [writeEffect("/repo/.git/config")] }))).toBe(true);
    expect(detectDestructiveActionOutsidePolicy(context({ effects: [writeEffect("node_modules/x/index.js")] }))).toBe(true);
    expect(detectDestructiveActionOutsidePolicy(context({ effects: [writeEffect("/repo/.gitignore")] }))).toBe(false);
    expect(detectDestructiveActionOutsidePolicy(context({ effects: [writeEffect("/repo/node_modules_backup/x")] }))).toBe(false);
  });

  it("only counts tool evidence when the tool was destructive and the result was not approve", () => {
    expect(detectDestructiveActionOutsidePolicy(context({ toolEvidence: [{ toolName: "rm", result: "ask" }] }))).toBe(true);
    expect(detectDestructiveActionOutsidePolicy(context({ toolEvidence: [{ toolName: "RM", result: "deny" }] }))).toBe(true);
    expect(detectDestructiveActionOutsidePolicy(context({ toolEvidence: [{ toolName: "rm", result: "approve" }] }))).toBe(false);
    // Evidence with no recorded result is not evidence of a denied action.
    expect(detectDestructiveActionOutsidePolicy(context({ toolEvidence: [{ toolName: "rm" }] }))).toBe(false);
    expect(detectDestructiveActionOutsidePolicy(context({ toolEvidence: [{ toolName: "read_file", result: "deny" }] }))).toBe(false);
  });

  it("does not treat a write_file to an ordinary path as destructive", () => {
    expect(detectDestructiveActionOutsidePolicy(context({ effects: [writeEffect("/repo/src/a.ts")] }))).toBe(false);
  });
});

describe("Sofie evidence thresholds", () => {
  it("closure needs at least one effect, decision, or target summary", () => {
    expect(detectInsufficientEvidence(context({ kind: "closure" }))).toBe(true);
    expect(detectInsufficientEvidence(context({ kind: "closure", effects: [writeEffect("/a")] }))).toBe(false);
    expect(detectInsufficientEvidence(context({ kind: "closure", decisions: [decision("deny")] }))).toBe(false);
    // For closure an empty target summary counts as a signal.
    expect(detectInsufficientEvidence(context({ kind: "closure", targetSummary: {} }))).toBe(false);
  });

  it("review needs a decision, an effect, or a target summary with at least one boolean gate", () => {
    expect(detectInsufficientEvidence(context({ kind: "review" }))).toBe(true);
    // Unlike closure, an empty target summary is not a review signal.
    expect(detectInsufficientEvidence(context({ kind: "review", targetSummary: {} }))).toBe(true);
    expect(detectInsufficientEvidence(context({ kind: "review", targetSummary: { notes: ["n"] } }))).toBe(true);
    expect(detectInsufficientEvidence(context({ kind: "review", targetSummary: { buildOk: false } }))).toBe(false);
    expect(detectInsufficientEvidence(context({ kind: "review", decisions: [decision("approve")] }))).toBe(false);
  });

  it("never applies to planning, scope, or operator questions", () => {
    for (const kind of ["planning", "scope", "operator"] as const) {
      expect(detectInsufficientEvidence(context({ kind }))).toBe(false);
      expect(decideSofieEscalation(context({ kind, question: "What next?" })).escalate).toBe(false);
    }
  });
});

describe("Sofie routine answers", () => {
  it("marks a review with a denied decision as caution but still lets work continue", () => {
    const answer = answerRoutineQuestion(context({ decisions: [decision("deny")] }));
    expect(answer.verdict).toBe("caution");
    expect(answer.closureRecommendation).toBe("continue");
    expect(answer.summary).toContain("bounded concerns");
    expect(answer.escalation.escalate).toBe(false);
  });

  it("warns about a tool_use with no tool_result in the evidence details", () => {
    const answer = answerRoutineQuestion(context({
      kind: "scope",
      question: "Is this still in scope?",
      tapeEventTypes: ["message_start", "tool_use"],
    }));
    expect(answer.details).toContain("tapeEvents=message_start,tool_use");
    expect(answer.details).toContain("tapeWarning=tool_use_without_result");
    expect(answer.summary).toBe("Sofie sees work remaining in scope.");
    expect(answer.scopeDriftDetected).toBe(false);
  });

  it("reports scope drift on a scope question without escalating when no frozen marker is hit", () => {
    // "new feature" is a generic drift marker but not a frozen-contract one,
    // yet detectScopeDrift also feeds the escalation ladder.
    const answer = answerRoutineQuestion(context({ kind: "scope", question: "They asked for a new feature" }));
    expect(answer.scopeDriftDetected).toBe(true);
    expect(answer.verdict).toBe("escalate");
    expect(answer.escalation.reason).toBe("frozen_contract_change");
  });

  it("appends friction findings and target notes after the evidence summary", () => {
    const answer = answerRoutineQuestion(context({
      kind: "closure",
      question: "Close?",
      effects: [writeEffect("/a")],
      frictionFindings: ["f1", "f2"],
      targetSummary: { installOk: true, notes: ["n1"] },
      provenance: { provider: "pi", model: null },
      targetRepo: { name: "demo", path: "/tmp/demo" },
    }));
    expect(answer.details.slice(-2)).toEqual(["friction=f1 | f2", "targetNotes=n1"]);
    expect(answer.details).toContain("provider=pi model=unknown");
    expect(answer.details).toContain("target=demo");
    expect(answer.closureRecommendation).toBe("complete");
  });
});

describe("makeApprovalSummaries", () => {
  it("projects only the four summary fields off each approval decision", () => {
    const summaries = makeApprovalSummaries([{
      packetId: "p1",
      toolCallId: "t1",
      outcome: "approve",
      actor: "operator",
      reason: "ok",
      decidedAt: "2026-04-09T00:00:00.000Z",
    }]);
    expect(summaries).toEqual([{ actor: "operator", outcome: "approve", reason: "ok", decidedAt: "2026-04-09T00:00:00.000Z" }]);
  });
});
