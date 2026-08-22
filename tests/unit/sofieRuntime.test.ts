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

describe("sofie runtime: a damaged policy log", () => {
  const DAMAGED_ID = "sofie-rt-torn";
  let outRoot: string;

  function denyDecision() {
    return { ...policyDecision(), toolCallId: "t-deny", result: "deny", winningRuleId: "deny-secrets" };
  }

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "pi-sofie-torn-"));
    const sessionDir = join(outRoot, "sessions", DAMAGED_ID);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(join(outRoot, "effects"), { recursive: true });
    // A normal run: the loop wrote a file and policy recorded a deny, then the
    // process died mid-append and left a partial JSON line with no newline.
    await writeFile(join(outRoot, "effects", `${DAMAGED_ID}.jsonl`), JSON.stringify(effectRecord()) + "\n");
    await writeFile(
      join(sessionDir, "policy.jsonl"),
      JSON.stringify(denyDecision()) + "\n" + '{"schemaVersion":1,"toolCallId":"t2","res',
    );
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("keeps the decisions that did parse instead of dropping the whole log", async () => {
    const context = await buildSofieContextFromSession({ sessionId: DAMAGED_ID, outRoot }, "Does this pass?", "review");

    expect(context.decisions?.map((decision) => decision.result)).toEqual(["deny"]);
    expect(context.frictionFindings).toContain("policyLogUnparsedLines=1");
  });

  it("still reports the recorded deny rather than certifying a clean review", async () => {
    // Regression: readPolicyLog rejects the entire file on one bad line, and
    // Sofie's catch turned that into zero decisions. With effects present the
    // insufficient-evidence guard does not fire, so a single torn byte range
    // flipped the verdict from "caution" to "review passes".
    const answer = await answerSofieSessionQuestion({ sessionId: DAMAGED_ID, outRoot }, "Does this pass?", "review");

    expect(answer.verdict).toBe("caution");
    expect(answer.summary).toContain("bounded concerns");
  });
});

describe("sofie runtime: a damaged effect log", () => {
  const DAMAGED_ID = "sofie-rt-eff-torn";
  let outRoot: string;

  function destructiveEffect() {
    // A write into .git is what detectDestructiveActionOutsidePolicy escalates on.
    return { ...effectRecord(), paths: [".git/config"], postHashes: { ".git/config": "sha256:abc" } };
  }

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "pi-sofie-eff-torn-"));
    const sessionDir = join(outRoot, "sessions", DAMAGED_ID);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(join(outRoot, "effects"), { recursive: true });
    await writeFile(
      join(outRoot, "effects", `${DAMAGED_ID}.jsonl`),
      JSON.stringify(destructiveEffect()) + "\n" + '{"schemaVersion":1,"toolCallId":"t2","too',
    );
    // A real run records a decision per tool call, so the insufficient-evidence
    // guard does not fire and mask the dropped effect.
    await writeFile(join(sessionDir, "policy.jsonl"), JSON.stringify(policyDecision()) + "\n");
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("keeps the effects that did parse and flags the ones that did not", async () => {
    const context = await buildSofieContextFromSession({ sessionId: DAMAGED_ID, outRoot }, "Is this run complete?", "closure");

    expect(context.effects?.map((effect) => effect.paths)).toEqual([[".git/config"]]);
    expect(context.frictionFindings).toContain("effectLogUnparsedLines=1");
  });

  it("still escalates the destructive write instead of recommending closure", async () => {
    // Regression: readEffectLog rejects the entire file on one bad line, and
    // Sofie's catch turned that into zero effects, so the .git write that
    // drives destructive_outside_policy disappeared and the run was certified
    // complete.
    const answer = await answerSofieSessionQuestion({ sessionId: DAMAGED_ID, outRoot }, "Is this run complete?", "closure");

    expect(answer.verdict).toBe("escalate");
    expect(answer.escalation.reason).toBe("destructive_outside_policy");
    expect(answer.closureRecommendation).toBe("needs-human");
  });
});
