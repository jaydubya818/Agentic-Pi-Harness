import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOrThrow, PolicyDecision, PolicyDecisionSchema } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

export type PolicyMode = "placeholder" | "real";
export type PolicyRuntimeLoopMode = "plan" | "assist" | "autonomous" | "worker" | "dry-run";

export interface PolicyDecisionInput {
  toolCallId: string;
  toolName: string;
  mode: PolicyRuntimeLoopMode;
  input: unknown;
  policyDigest?: string;
}

export interface PolicyDecider {
  decide(input: PolicyDecisionInput): PolicyDecision;
}

export interface PlaceholderDecisionInput {
  toolCallId: string;
  modeInfluence: PolicyRuntimeLoopMode;
  policyDigest: string;
  at?: string;
}

/**
 * Placeholder policy engine for Tier A. Always approves, records provenance
 * as "placeholder" so Tier B can swap in the real engine without touching callers.
 */
export function placeholderApprove(input: PlaceholderDecisionInput): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId: input.toolCallId,
    result: "approve",
    provenanceMode: "placeholder",
    modeInfluence: input.modeInfluence,
    manifestInfluence: null,
    ruleEvaluation: [],
    evaluationOrder: [],
    winningRuleId: null,
    hookDecision: null,
    mutatedByHook: false,
    approvalRequiredBy: null,
    policyDigest: input.policyDigest,
    at: input.at ?? new Date().toISOString(),
  };
}

export function decidePolicy(input: {
  policyMode?: PolicyMode;
  policy?: PolicyDecider;
  toolCallId: string;
  toolName: string;
  mode: PolicyRuntimeLoopMode;
  input: unknown;
  policyDigest?: string;
}): PolicyDecision {
  const policyMode = input.policyMode ?? "placeholder";
  if (policyMode === "real") {
    if (!input.policy) {
      throw new PiHarnessError("E_UNKNOWN", "real policy mode requires a policy decider", {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      });
    }
    return input.policy.decide({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      mode: input.mode,
      input: input.input,
      policyDigest: input.policyDigest,
    });
  }

  return placeholderApprove({
    toolCallId: input.toolCallId,
    modeInfluence: input.mode,
    policyDigest: input.policyDigest ?? "sha256:policy-unknown",
  });
}

export async function appendPolicyDecision(path: string, decision: PolicyDecision): Promise<void> {
  const parsed = PolicyDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "policy decision invalid", { issues: parsed.error.issues });
  }

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(parsed.data) + "\n", "utf8");
}

export async function readPolicyLog(path: string): Promise<PolicyDecision[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "failed to read policy log", {
      path,
      cause: String(error),
    });
  }

  const lines = raw.split("\n").filter(Boolean);
  return lines.map((line, index) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "failed to parse policy log json", {
        path,
        line: index + 1,
        cause: String(error),
      });
    }

    try {
      return parseOrThrow(PolicyDecisionSchema, parsedJson, `policy line ${index + 1}`);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "policy log schema invalid", {
        path,
        line: index + 1,
        cause: String(error),
      });
    }
  });
}

export function renderPolicyInspection(decisions: PolicyDecision[]): string {
  return decisions.map((decision) => {
    const winningRule = decision.winningRuleId ? ` winningRule=${decision.winningRuleId}` : "";
    const approval = decision.approvalRequiredBy ? ` approvalRequiredBy=${decision.approvalRequiredBy}` : "";
    const manifest = decision.manifestInfluence
      ? ` manifestInfluence=${decision.manifestInfluence.field}:${decision.manifestInfluence.value}`
      : "";
    const hook = decision.hookDecision
      ? ` hookDecision=${decision.hookDecision.decision}@${decision.hookDecision.hookId}${decision.hookDecision.reason ? `:${decision.hookDecision.reason}` : ""}`
      : "";
    return `${decision.at} ${decision.toolCallId} ${decision.result} provenance=${decision.provenanceMode} mode=${decision.modeInfluence} policyDigest=${decision.policyDigest}${winningRule}${approval}${manifest}${hook}`;
  }).join("\n");
}
