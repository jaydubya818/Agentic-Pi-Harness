import { EffectRecord, PolicyDecision } from "../schemas/index.js";
import { ApprovalDecision } from "../approvals/runtime.js";

export type SofieQuestionKind = "planning" | "review" | "closure" | "scope" | "operator";

export type SofieEscalationReason =
  | "destructive_outside_policy"
  | "credentials_or_permissions"
  | "ambiguous_business_decision"
  | "frozen_contract_change"
  | "insufficient_evidence";

export interface SofieApprovalSummary {
  actor: string;
  outcome: ApprovalDecision["outcome"];
  reason?: string;
  decidedAt: string;
}

export interface SofieToolEvidence {
  toolName: string;
  toolCallId?: string;
  result?: "approve" | "deny" | "ask";
  paths?: string[];
}

export interface SofieContext {
  sessionId: string;
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  question: string;
  kind: SofieQuestionKind;
  tapeEventTypes?: string[];
  effects?: EffectRecord[];
  decisions?: PolicyDecision[];
  toolEvidence?: SofieToolEvidence[];
  approvals?: SofieApprovalSummary[];
  provenance?: {
    provider?: string | null;
    model?: string | null;
    repoGitSha?: string | null;
    loopGitSha?: string | null;
    policyDigest?: string | null;
  };
  frictionFindings?: string[];
  targetRepo?: {
    name: string;
    path: string;
    validationCommands?: string[];
  };
  targetSummary?: {
    installOk?: boolean;
    buildOk?: boolean;
    lintOk?: boolean;
    notes?: string[];
  };
}

export interface SofieEscalation {
  escalate: boolean;
  reason: SofieEscalationReason | null;
  why: string;
}

export interface SofieAnswer {
  actor: "sofie";
  kind: SofieQuestionKind;
  verdict: "answer" | "approve" | "caution" | "escalate";
  summary: string;
  details: string[];
  closureRecommendation: "continue" | "complete" | "needs-human";
  scopeDriftDetected: boolean;
  escalation: SofieEscalation;
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function detectScopeDrift(context: SofieContext): boolean {
  const text = normalized(`${context.question} ${(context.frictionFindings ?? []).join(" ")}`);
  return hasAny(text, ["mission control ui", "canonical golden", "goldens", "proof-path cli", "artifact filename", "artifact location", "milestone semantic", "free-roaming second builder"]);
}

export function summarizeRoutineEvidence(context: SofieContext): string[] {
  const details: string[] = [];
  details.push(`mode=${context.mode}`);
  details.push(`effects=${context.effects?.length ?? 0}`);
  details.push(`policyDecisions=${context.decisions?.length ?? 0}`);
  details.push(`toolEvidence=${context.toolEvidence?.length ?? 0}`);
  details.push(`approvals=${context.approvals?.length ?? 0}`);
  if (context.provenance?.provider || context.provenance?.model) {
    details.push(`provider=${context.provenance.provider ?? "unknown"} model=${context.provenance.model ?? "unknown"}`);
  }
  if (context.targetRepo) {
    details.push(`target=${context.targetRepo.name}`);
  }
  return details;
}

export function detectFrozenContractRisk(context: SofieContext): boolean {
  const text = normalized(context.question);
  return hasAny(text, ["golden", "proof path", "proof-path", "artifact shape", "artifact filename", "artifact location", "milestone semantic", "frozen contract"]);
}

export function detectCredentialOrPermissionBlocker(context: SofieContext): boolean {
  const text = normalized(`${context.question} ${(context.frictionFindings ?? []).join(" ")}`);
  return hasAny(text, ["credential", "credentials", "secret", "secrets", "permission", "permissions", "access denied", "forbidden", "unauthorized"]);
}

export function detectAmbiguousBusinessDecision(context: SofieContext): boolean {
  const text = normalized(context.question);
  return hasAny(text, ["product direction", "business decision", "pricing", "roadmap priority", "brand direction", "which market"]);
}

function isDestructiveToolName(toolName: string): boolean {
  return ["delete_file", "rm", "git_push", "deploy"].includes(toolName.toLowerCase());
}

export function detectDestructiveActionOutsidePolicy(context: SofieContext): boolean {
  const deniedDestructiveByEvidence = (context.toolEvidence ?? []).some((evidence) =>
    !!evidence.result && evidence.result !== "approve" && isDestructiveToolName(evidence.toolName)
  );
  const destructivePathWrite = (context.effects ?? []).some((effect) =>
    effect.toolName === "write_file" && effect.paths.some((path) => /(^|\/)(\.git|node_modules)(\/|$)/.test(path))
  );
  const questionText = normalized(context.question);
  return deniedDestructiveByEvidence
    || destructivePathWrite
    || hasAny(questionText, ["delete repo", "wipe", "drop database", "push to production", "rotate secrets"]);
}

export function detectInsufficientEvidence(context: SofieContext): boolean {
  if (context.kind === "closure") {
    const hasSignals = (context.effects?.length ?? 0) > 0 || (context.decisions?.length ?? 0) > 0 || !!context.targetSummary;
    return !hasSignals;
  }
  if (context.kind === "review") {
    const hasTargetSignals = !!context.targetSummary && [context.targetSummary.installOk, context.targetSummary.buildOk, context.targetSummary.lintOk].some((value) => typeof value === "boolean");
    return (context.decisions?.length ?? 0) === 0 && (context.effects?.length ?? 0) === 0 && !hasTargetSignals;
  }
  return false;
}

export function decideSofieEscalation(context: SofieContext): SofieEscalation {
  if (detectDestructiveActionOutsidePolicy(context)) {
    return { escalate: true, reason: "destructive_outside_policy", why: "request touches destructive work outside Sofie's bounded authority" };
  }
  if (detectCredentialOrPermissionBlocker(context)) {
    return { escalate: true, reason: "credentials_or_permissions", why: "credentials, secrets, or permissions remain unresolved" };
  }
  if (detectAmbiguousBusinessDecision(context)) {
    return { escalate: true, reason: "ambiguous_business_decision", why: "business or product direction lacks a safe deterministic default" };
  }
  if (detectFrozenContractRisk(context) || detectScopeDrift(context)) {
    return { escalate: true, reason: "frozen_contract_change", why: "request would alter a frozen proof path, artifact contract, or out-of-scope area" };
  }
  if (detectInsufficientEvidence(context)) {
    return { escalate: true, reason: "insufficient_evidence", why: "runtime artifacts do not contain enough evidence for a bounded answer" };
  }
  return { escalate: false, reason: null, why: "routine internal question is answerable from existing runtime evidence" };
}

export function answerRoutineQuestion(context: SofieContext): SofieAnswer {
  const escalation = decideSofieEscalation(context);
  const scopeDriftDetected = detectScopeDrift(context);
  const details = summarizeRoutineEvidence(context);

  if (context.frictionFindings?.length) {
    details.push(`friction=${context.frictionFindings.join(" | ")}`);
  }
  if (context.targetSummary?.notes?.length) {
    details.push(`targetNotes=${context.targetSummary.notes.join(" | ")}`);
  }

  if (escalation.escalate) {
    return {
      actor: "sofie",
      kind: context.kind,
      verdict: "escalate",
      summary: escalation.why,
      details,
      closureRecommendation: "needs-human",
      scopeDriftDetected,
      escalation,
    };
  }

  const wroteFiles = (context.effects?.length ?? 0) > 0;
  const denied = (context.decisions ?? []).some((decision) => decision.result === "deny");
  const summary = context.kind === "closure"
    ? wroteFiles || context.targetSummary ? "Sofie recommends bounded closure based on recorded evidence." : "Sofie sees no closure signals."
    : context.kind === "review"
      ? denied
        ? "Sofie review found bounded concerns in existing policy/runtime evidence."
        : context.targetSummary
          ? "Sofie review passes within bounded authority using harness-local validation evidence."
          : "Sofie review passes within bounded authority."
      : context.kind === "scope"
        ? scopeDriftDetected ? "Sofie detected scope drift." : "Sofie sees work remaining in scope."
        : "Sofie answered from existing artifacts without human escalation.";

  return {
    actor: "sofie",
    kind: context.kind,
    verdict: denied ? "caution" : "answer",
    summary,
    details,
    closureRecommendation: context.kind === "closure" ? "complete" : "continue",
    scopeDriftDetected,
    escalation,
  };
}

export function makeApprovalSummaries(approvals: ApprovalDecision[]): SofieApprovalSummary[] {
  return approvals.map((approval) => ({
    actor: approval.actor,
    outcome: approval.outcome,
    reason: approval.reason,
    decidedAt: approval.decidedAt,
  }));
}
