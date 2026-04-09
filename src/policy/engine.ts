import { z } from "zod";
import { PolicyDecision } from "../schemas/index.js";

export const PolicyMatchSchema = z.object({
  tool: z.string().min(1).optional(),
  mode: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]).optional(),
  path: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
}).partial();
export type PolicyMatch = z.infer<typeof PolicyMatchSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["approve", "deny", "ask"]),
  match: PolicyMatchSchema.default({}),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDocSchema = z.object({
  schemaVersion: z.literal(1),
  defaultAction: z.enum(["approve", "deny", "ask"]),
  rules: z.array(PolicyRuleSchema),
});
export type PolicyDoc = z.infer<typeof PolicyDocSchema>;

export interface DecisionInput {
  toolCallId: string;
  toolName: string;
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  input: unknown;
  policyDigest?: string;
  at?: string;
}

function pathsOf(input: unknown): string[] {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string") return [record.path];
    if (Array.isArray(record.paths)) return record.paths.filter((path): path is string => typeof path === "string");
  }
  return [];
}

export function ruleMatches(rule: PolicyRule, input: DecisionInput): boolean {
  const match = rule.match ?? {};
  if (match.tool && match.tool !== input.toolName) return false;
  if (match.mode && match.mode !== input.mode) return false;

  const paths = pathsOf(input.input);
  if (match.path && !paths.some((path) => path === match.path)) return false;
  if (match.pathPrefix && !paths.some((path) => path.startsWith(match.pathPrefix!))) return false;

  return true;
}

export function evaluatePolicyDecision(doc: PolicyDoc, input: DecisionInput): PolicyDecision {
  const evaluationOrder = doc.rules.map((rule) => rule.id);
  let winningRuleIndex = -1;

  const ruleEvaluation = doc.rules.map((rule, index) => {
    const matched = ruleMatches(rule, input);
    if (matched && winningRuleIndex === -1) winningRuleIndex = index;
    return {
      scope: "project" as const,
      ruleId: rule.id,
      matched,
      effect: rule.action === "approve" ? "allow" as const : "deny" as const,
    };
  });

  const winningRule = winningRuleIndex === -1 ? null : doc.rules[winningRuleIndex];
  const result = winningRule ? winningRule.action : doc.defaultAction;

  return {
    schemaVersion: 1,
    toolCallId: input.toolCallId,
    result,
    provenanceMode: "real",
    modeInfluence: input.mode,
    manifestInfluence: null,
    ruleEvaluation,
    evaluationOrder,
    winningRuleId: winningRule ? winningRule.id : null,
    hookDecision: null,
    mutatedByHook: false,
    approvalRequiredBy: null,
    policyDigest: input.policyDigest ?? "sha256:policy-unknown",
    at: input.at ?? new Date().toISOString(),
  };
}

export class PolicyEngine {
  constructor(private readonly doc: PolicyDoc) {}

  decide(input: DecisionInput): PolicyDecision {
    return evaluatePolicyDecision(this.doc, input);
  }

  getRules(): PolicyRule[] {
    return [...this.doc.rules];
  }
}
