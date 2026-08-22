import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalDecision } from "../approvals/runtime.js";
import { readEffectLogLenient } from "../effect/recorder.js";
import { readPolicyLogLenient } from "../policy/decision.js";
import { readProvenance } from "../session/provenance.js";
import { SofieAnswer, SofieContext, SofieToolEvidence, answerRoutineQuestion, makeApprovalSummaries } from "./authority.js";

export interface SofieSessionArtifacts {
  sessionId: string;
  outRoot: string;
  mode?: SofieContext["mode"];
  approvals?: ApprovalDecision[];
  frictionFindings?: string[];
  tapeEventTypes?: string[];
  toolEvidence?: SofieToolEvidence[];
  targetRepo?: SofieContext["targetRepo"];
  targetSummary?: SofieContext["targetSummary"];
}

async function tryReadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function buildSofieContextFromSession(input: SofieSessionArtifacts, question: string, kind: SofieContext["kind"]): Promise<SofieContext> {
  const sessionDir = join(input.outRoot, "sessions", input.sessionId);
  const effectsPath = join(input.outRoot, "effects", `${input.sessionId}.jsonl`);
  const policyPath = join(sessionDir, "policy.jsonl");
  const provenancePath = join(sessionDir, "provenance.json");
  const checkpointPath = join(sessionDir, "checkpoint.json");

  const [effectLog, policyLog, checkpoint, provenance] = await Promise.all([
    readEffectLogLenient(effectsPath),
    readPolicyLogLenient(policyPath),
    tryReadJson<{ stopReason?: string | null }>(checkpointPath),
    readProvenance(provenancePath).catch(() => null),
  ]);

  return {
    sessionId: input.sessionId,
    mode: input.mode ?? "assist",
    question,
    kind,
    tapeEventTypes: input.tapeEventTypes,
    effects: effectLog.records,
    decisions: policyLog.decisions,
    toolEvidence: input.toolEvidence,
    approvals: makeApprovalSummaries(input.approvals ?? []),
    provenance: provenance
      ? {
          provider: provenance.provider,
          model: provenance.model,
          repoGitSha: provenance.repoGitSha,
          loopGitSha: provenance.loopGitSha,
          policyDigest: provenance.policyDigest,
        }
      : undefined,
    frictionFindings: [
      ...(input.frictionFindings ?? []),
      ...(checkpoint?.stopReason ? [`stopReason=${checkpoint.stopReason}`] : []),
      // Damaged evidence is itself a finding: the surviving decisions still
      // count, but the operator has to know some were unreadable rather than
      // reading a short log as a quiet one.
      ...(policyLog.skippedLines > 0 ? [`policyLogUnparsedLines=${policyLog.skippedLines}`] : []),
      ...(effectLog.skippedLines > 0 ? [`effectLogUnparsedLines=${effectLog.skippedLines}`] : []),
    ],
    targetRepo: input.targetRepo,
    targetSummary: input.targetSummary,
  };
}

export async function answerSofieSessionQuestion(input: SofieSessionArtifacts, question: string, kind: SofieContext["kind"]): Promise<SofieAnswer> {
  const context = await buildSofieContextFromSession(input, question, kind);
  return answerRoutineQuestion(context);
}
