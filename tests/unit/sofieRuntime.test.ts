import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerSofieSessionQuestion, buildSofieContextFromSession } from "../../src/sofie/runtime.js";

const SESSION_ID = "sofie-rt-test";

function effectRecord() {
  return {
    schemaVersion: 1,
    toolCallId: "t1",
    sessionId: SESSION_ID,
    toolName: "write_file",
    paths: ["notes.md"],
    preHashes: {},
    postHashes: { "notes.md": "sha256:abc" },
    unifiedDiff: "",
    binaryChanged: false,
    timestamp: new Date().toISOString(),
  };
}

function policyDecision() {
  return {
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
    policyDigest: "sha256:test",
    at: new Date().toISOString(),
  };
}

describe("sofie runtime: buildSofieContextFromSession", () => {
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "pi-sofie-rt-"));
    const sessionDir = join(outRoot, "sessions", SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(join(outRoot, "effects"), { recursive: true });
    await writeFile(join(outRoot, "effects", `${SESSION_ID}.jsonl`), JSON.stringify(effectRecord()) + "\n");
    await writeFile(join(sessionDir, "policy.jsonl"), JSON.stringify(policyDecision()) + "\n");
    await writeFile(join(sessionDir, "checkpoint.json"), JSON.stringify({ stopReason: "end_turn" }) + "\n");
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("assembles effects, decisions, and checkpoint stop reason from session artifacts", async () => {
    const context = await buildSofieContextFromSession(
      { sessionId: SESSION_ID, outRoot },
      "Is this run complete?",
      "closure",
    );

    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.mode).toBe("assist");
    expect(context.effects).toHaveLength(1);
    expect(context.decisions).toHaveLength(1);
    expect(context.frictionFindings).toContain("stopReason=end_turn");
    expect(context.provenance).toBeUndefined(); // no provenance.json written
  });

  it("tolerates a session directory with no artifacts at all", async () => {
    const context = await buildSofieContextFromSession(
      { sessionId: "does-not-exist", outRoot },
      "Anything recorded?",
      "closure",
    );

    expect(context.effects).toEqual([]);
    expect(context.decisions).toEqual([]);
    expect(context.frictionFindings).toEqual([]);
  });

  it("answers a closure question from the recorded evidence without escalation", async () => {
    const answer = await answerSofieSessionQuestion(
      { sessionId: SESSION_ID, outRoot },
      "Is this run complete?",
      "closure",
    );

    expect(answer.actor).toBe("sofie");
    expect(answer.verdict).toBe("answer");
    expect(answer.closureRecommendation).toBe("complete");
    expect(answer.escalation.escalate).toBe(false);
  });

  it("escalates a closure question when the session left no evidence", async () => {
    const answer = await answerSofieSessionQuestion(
      { sessionId: "does-not-exist", outRoot },
      "Is this run complete?",
      "closure",
    );

    expect(answer.verdict).toBe("escalate");
    expect(answer.escalation.reason).toBe("insufficient_evidence");
    expect(answer.closureRecommendation).toBe("needs-human");
  });
});
