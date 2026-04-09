import { z } from "zod";

export const POLICY_DECISION_SCHEMA_VERSION = 1 as const;

export const PolicyDecisionSchema = z.object({
  schemaVersion: z.literal(POLICY_DECISION_SCHEMA_VERSION),
  toolCallId: z.string(),
  result: z.enum(["approve", "deny", "ask"]),
  provenanceMode: z.enum(["placeholder", "real"]),
  modeInfluence: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]),
  manifestInfluence: z.object({
    field: z.string(),
    value: z.string(),
  }).nullable(),
  ruleEvaluation: z.array(z.object({
    scope: z.enum(["enterprise", "project", "user"]),
    ruleId: z.string(),
    matched: z.boolean(),
    effect: z.enum(["allow", "deny"]),
  })),
  evaluationOrder: z.array(z.string()),
  winningRuleId: z.string().nullable(),
  hookDecision: z.object({
    hookId: z.string(),
    decision: z.string(),
    reason: z.string().optional(),
  }).nullable(),
  mutatedByHook: z.boolean(),
  approvalRequiredBy: z.enum(["mode", "rule", "manifest", "hook"]).nullable(),
  policyDigest: z.string(),
  at: z.string(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
