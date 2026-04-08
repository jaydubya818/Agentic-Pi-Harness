import { z } from "zod";
import { PolicyDecision } from "../schemas/index.js";

/**
 * Tier B permission engine: rule-based allow/deny with full provenance.
 * Rules are evaluated in order. First matching rule wins. If no rule matches,
 * the default action is used. Every decision records matched rules, winning
 * rule, evaluation order, and mode/manifest/hook influences.
 */

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    tool: z.string().optional(),            // glob, "*" wildcard
    mode: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]).optional(),
    pathPrefix: z.string().optional(),      // matches input.path / input.paths[*]
    inputContains: z.string().optional(),   // naive substring on JSON(input)
  }),
  action: z.enum(["approve", "deny", "ask"]),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDocSchema = z.object({
  schemaVersion: z.literal(1),
  default: z.enum(["approve", "deny", "ask"]),
  rules: z.array(PolicyRuleSchema),
});
export type PolicyDoc = z.infer<typeof PolicyDocSchema>;

export interface DecisionInput {
  toolCallId: string;
  toolName: string;
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  input: unknown;
  manifestInfluence?: string | null;
  hookInfluence?: string | null;
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(value);
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }

function pathsOf(input: unknown): string[] {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string") return [o.path];
    if (Array.isArray(o.paths)) return o.paths.filter((p): p is string => typeof p === "string");
  }
  return [];
}

function ruleMatches(rule: PolicyRule, inp: DecisionInput): boolean {
  const m = rule.match;
  if (m.tool && !globMatch(m.tool, inp.toolName)) return false;
  if (m.mode && m.mode !== inp.mode) return false;
  if (m.pathPrefix) {
    const ps = pathsOf(inp.input);
    if (!ps.some((p) => p.startsWith(m.pathPrefix!))) return false;
  }
  if (m.inputContains) {
    if (!JSON.stringify(inp.input ?? null).includes(m.inputContains)) return false;
  }
  return true;
}

export class PolicyEngine {
  constructor(private doc: PolicyDoc) {}

  decide(inp: DecisionInput): PolicyDecision {
    const matched: string[] = [];
    const order: string[] = [];
    let winning: PolicyRule | null = null;
    for (const r of this.doc.rules) {
      order.push(r.id);
      if (ruleMatches(r, inp)) {
        matched.push(r.id);
        if (!winning) winning = r;
      }
    }
    const result = winning ? winning.action : this.doc.default;
    return {
      schemaVersion: 1,
      toolCallId: inp.toolCallId,
      result,
      provenanceMode: "full",
      matchedRuleIds: matched,
      winningRuleId: winning?.id ?? null,
      evaluationOrder: order,
      modeInfluence: inp.mode,
      manifestInfluence: inp.manifestInfluence ?? null,
      hookInfluence: inp.hookInfluence ?? null,
      at: new Date().toISOString(),
    };
  }
}
