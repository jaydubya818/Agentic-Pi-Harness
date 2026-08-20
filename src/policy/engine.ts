import { posix } from "node:path";
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

/**
 * Collect every path a tool call targets. `path` and `paths` are unioned
 * rather than checked in precedence order: a call that carries both
 * (`{ path: "ok.txt", paths: ["secrets/key"] }`) used to have only `path`
 * inspected, so the extra targets never reached a path-scoped deny rule and
 * an approve rule covered them vacuously.
 */
function pathsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const collected: string[] = [];
  if (typeof record.path === "string") collected.push(record.path);
  if (Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === "string") collected.push(path);
    }
  }
  return [...new Set(collected)];
}

export function ruleMatches(rule: PolicyRule, input: DecisionInput): boolean {
  const match = rule.match ?? {};
  if (match.tool && match.tool !== input.toolName) return false;
  if (match.mode && match.mode !== input.mode) return false;
  if (!match.path && !match.pathPrefix) return true;

  const paths = pathsOf(input.input).map(normalizePolicyPath);
  // A path-scoped rule can never match a call that carries no paths at all:
  // `every` below would be vacuously true and hand an approve rule to a call
  // whose targets the rule was never able to inspect.
  if (paths.length === 0) return false;

  // An `approve` rule grants authority, so it must cover *every* path the
  // call touches. Plain `some` let a multi-path write ride a narrowly scoped
  // approve rule out of its subtree: `{ paths: ["tests/a", "/etc/shadow"] }`
  // matched `pathPrefix: "tests"` and was approved wholesale, and the
  // out-of-scope path never reached the deny rule below it. `deny` and `ask`
  // keep `some` semantics -- one in-scope path is enough to block or
  // escalate the whole call.
  const matchesPaths = rule.action === "approve"
    ? (predicate: (path: string) => boolean) => paths.every(predicate)
    : (predicate: (path: string) => boolean) => paths.some(predicate);

  if (match.path && !matchesPaths((path) => path === normalizePolicyPath(match.path!))) return false;
  if (match.pathPrefix && !matchesPaths((path) => pathHasPrefix(path, match.pathPrefix!))) return false;

  return true;
}

/**
 * Path matching operates on normalized posix-style paths so aliased
 * spellings of the same location ("./secrets/key", "secrets//key") cannot
 * dodge a deny rule, and traversal segments ("tests/../secrets/key") cannot
 * ride an approve rule out of its intended subtree.
 */
function normalizePolicyPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/"));
}

/**
 * Segment-aware prefix match: "tests" covers "tests" and "tests/x.ts" but
 * not "tests-evil/x.ts". Raw startsWith would let a pathPrefix approve rule
 * leak onto sibling paths that merely share leading characters. Paths that
 * still point above the root after normalization ("../x") never match a
 * prefix rule — their real location cannot be proven from the string.
 */
function pathHasPrefix(path: string, prefix: string): boolean {
  if (path === ".." || path.startsWith("../")) return false;
  const clean = normalizePolicyPath(prefix).replace(/\/+$/, "");
  return path === clean || path.startsWith(clean + "/");
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
