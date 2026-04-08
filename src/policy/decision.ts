import { PolicyDecision } from "../schemas/index.js";

/**
 * Placeholder policy engine for Tier A. Always approves, records provenance
 * as "placeholder" so Tier B can swap in the real engine without touching callers.
 */
export function placeholderApprove(toolCallId: string): PolicyDecision {
  return {
    schemaVersion: 1,
    toolCallId,
    result: "approve",
    provenanceMode: "placeholder",
    matchedRuleIds: [],
    winningRuleId: null,
    evaluationOrder: [],
    modeInfluence: null,
    manifestInfluence: null,
    hookInfluence: null,
    at: new Date().toISOString(),
  };
}
