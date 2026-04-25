import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalDecision } from "../approvals/runtime.js";
import { readEffectLog } from "../effect/recorder.js";
import { readPolicyLog } from "../policy/decision.js";
import { readProvenance } from "../session/provenance.js";
import { EffectRecord, PolicyDecision } from "../schemas/index.js";
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

async function tryReadEffects(path: string): Promise<EffectRecord[]> {
  try {
    return await readEffectLog(path);
  } catch {
    return [];
  }
}

async function tryReadPolicy(path: string): Promise<PolicyDecision[]> {
  try {
    return await readPolicyLog(path);
  } catch {
    return [];
  }
}

export async function buildSofieContextFromSession(input: SofieSessionArtifacts, question: string, kind: SofieContext["kind"]): Promise<SofieContext> {
  const sessionDir = join(input.outRoot, "sessions", input.sessionId);
  const effectsPath = join(input.outRoot, "effects", `${input.sessionId}.jsonl`);
  const policyPath = join(sessionDir, "policy.jsonl");
  const provenancePath = join(sessionDir, "provenance.json");
  const checkpointPath = join(sessionDir, "checkpoint.json");

  const [effects, decisions, checkpoint, provenance] = await Promise.all([
    tryReadEffects(effectsPath),
    tryReadPolicy(policyPath),
    tryReadJson<{ stopReason?: string | null }>(checkpointPath),
    readProvenance(provenancePath).catch(() => null),
  ]);

  return {
    sessionId: input.sessionId,
    mode: input.mode ?? "assist",
    question,
    kind,
    tapeEventTypes: input.tapeEventTypes,
    effects,
    decisions,
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
    ],
    targetRepo: input.targetRepo,
    targetSummary: input.targetSummary,
  };
}

export async function answerSofieSessionQuestion(input: SofieSessionArtifacts, question: string, kind: SofieContext["kind"]): Promise<SofieAnswer> {
  const context = await buildSofieContextFromSession(input, question, kind);
  return answerRoutineQuestion(context);
}
