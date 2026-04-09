import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOrThrow, PolicyDecision, PolicyDecisionSchema } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

export interface PlaceholderDecisionInput {
  toolCallId: string;
  modeInfluence: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
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
    return `${decision.at} ${decision.toolCallId} ${decision.result} provenance=${decision.provenanceMode} mode=${decision.modeInfluence} policyDigest=${decision.policyDigest}${winningRule}${approval}`;
  }).join("\n");
}
