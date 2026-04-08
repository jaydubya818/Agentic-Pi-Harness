/**
 * Semantic decision hash — rule-id agnostic.
 *
 * Level C v0.1 compares policy decisions by `toolCallId`, `result`, and
 * `winningRuleId`. That catches drift when rules change but misses
 * semantically-equivalent rule rewrites: if I rename `deny-secrets` to
 * `block-etc-paths` but the new rule denies the exact same set of calls,
 * Level C v0.1 flags every call as drifted.
 *
 * v0.2 adds a semantic hash over just `{result, toolName, effectClass}`
 * where `effectClass` is a coarse categorization of the input surface
 * area (read-path / write-path / exec / net). Two rule sets with the
 * same semantic hash per decision are equivalent at the policy surface.
 */

import { createHash } from "node:crypto";
import { PolicyDecision } from "../schemas/index.js";

export type EffectClass = "read-path" | "write-path" | "exec" | "net" | "other";

/**
 * Classify an input's surface area. Heuristic but deterministic — as long
 * as the rule matches the same call, the class comes out the same.
 */
export function classifyEffect(toolName: string, input: unknown): EffectClass {
  const n = toolName.toLowerCase();
  if (n.startsWith("read") || n.includes("_read") || n === "ls" || n === "stat") return "read-path";
  if (n.startsWith("write") || n.includes("_write") || n === "mv" || n === "rm" || n === "mkdir") return "write-path";
  if (n === "bash" || n === "exec" || n === "sh" || n.includes("_exec")) return "exec";
  if (n.startsWith("http") || n === "fetch" || n === "curl" || n.includes("_net")) return "net";
  // Fall back on input shape
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.url === "string") return "net";
    if (typeof o.cmd === "string") return "exec";
    if (typeof o.path === "string" || Array.isArray(o.paths)) {
      // no writable indicator -> assume read
      if ("content" in o || "data" in o) return "write-path";
      return "read-path";
    }
  }
  return "other";
}

export function semanticDecisionHash(decision: PolicyDecision, toolName: string, input: unknown): string {
  const cls = classifyEffect(toolName, input);
  const canonical = JSON.stringify({
    r: decision.result,       // approve | deny | ask
    t: toolName,              // tool identity (not rule identity)
    c: cls,                   // effect class
  });
  return "sha256-semantic:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Compare two decision logs semantically. Returns the list of toolCallIds
 * whose semantic hashes diverge between the two logs.
 */
export function semanticDrift(
  a: Array<{ decision: PolicyDecision; toolName: string; input: unknown }>,
  b: Array<{ decision: PolicyDecision; toolName: string; input: unknown }>,
): string[] {
  const hashA = new Map(a.map((r) => [r.decision.toolCallId, semanticDecisionHash(r.decision, r.toolName, r.input)]));
  const hashB = new Map(b.map((r) => [r.decision.toolCallId, semanticDecisionHash(r.decision, r.toolName, r.input)]));
  const drifted: string[] = [];
  for (const [id, ha] of hashA) {
    const hb = hashB.get(id);
    if (hb !== ha) drifted.push(id);
  }
  return drifted;
}
