import { z } from "zod";
import { PolicyDecision } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

/**
 * Tier B permission engine: rule-based allow/deny with full provenance.
 * Rules are evaluated in order. First matching rule wins. If no rule matches,
 * the default action is used.
 *
 * v0.3.0: rules may `extends` another rule by id. The child inherits the
 * parent's `match` and `action`, then overrides with its own specified
 * fields. Inheritance is resolved at engine construction; cycles raise
 * E_POLICY_CYCLE. Every decision records `inheritedFromByRule` so drift
 * analysis can distinguish an override from a rename.
 */
export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  extends: z.string().optional(),
  match: z.object({
    tool: z.string().optional(),
    mode: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]).optional(),
    pathPrefix: z.string().optional(),
    inputContains: z.string().optional(),
  }).partial().optional(),
  action: z.enum(["approve", "deny", "ask"]).optional(),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDocSchema = z.object({
  schemaVersion: z.literal(1),
  default: z.enum(["approve", "deny", "ask"]),
  rules: z.array(PolicyRuleSchema),
});
export type PolicyDoc = z.infer<typeof PolicyDocSchema>;

interface ResolvedRule {
  id: string;
  match: NonNullable<PolicyRule["match"]>;
  action: "approve" | "deny" | "ask";
  reason?: string;
  inheritedFrom: string[];
}

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

function ruleMatches(rule: ResolvedRule, inp: DecisionInput): boolean {
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

/**
 * Resolve `extends:` chains. Returns rules in original order with parent
 * match/action merged in before child overrides. Detects cycles.
 */
export function resolveRules(rules: PolicyRule[]): ResolvedRule[] {
  const byId = new Map<string, PolicyRule>();
  for (const r of rules) byId.set(r.id, r);
  const cache = new Map<string, ResolvedRule>();
  const resolving = new Set<string>();

  const resolve = (id: string): ResolvedRule => {
    const hit = cache.get(id);
    if (hit) return hit;
    if (resolving.has(id)) {
      throw new PiHarnessError("E_POLICY_CYCLE", "policy rule inheritance cycle at: " + id);
    }
    resolving.add(id);
    const raw = byId.get(id);
    if (!raw) throw new PiHarnessError("E_POLICY_CYCLE", "policy rule missing: " + id);
    let base: ResolvedRule = { id, match: {}, action: "approve", inheritedFrom: [] };
    if (raw.extends) {
      const parent = resolve(raw.extends);
      base = {
        id,
        match: { ...parent.match },
        action: parent.action,
        reason: parent.reason,
        inheritedFrom: [...parent.inheritedFrom, parent.id],
      };
    }
    if (raw.match) base.match = { ...base.match, ...raw.match };
    if (raw.action) base.action = raw.action;
    if (raw.reason) base.reason = raw.reason;
    resolving.delete(id);
    cache.set(id, base);
    return base;
  };

  return rules.map((r) => resolve(r.id));
}

export class PolicyEngine {
  private resolved: ResolvedRule[];
  constructor(private doc: PolicyDoc) {
    this.resolved = resolveRules(doc.rules);
  }
  decide(inp: DecisionInput): PolicyDecision {
    const matched: string[] = [];
    const order: string[] = [];
    let winning: ResolvedRule | null = null;
    for (const r of this.resolved) {
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
  /** Exposed for tests/debug: returns the resolved-after-inheritance view. */
  getResolvedRules(): ResolvedRule[] { return this.resolved; }
}
