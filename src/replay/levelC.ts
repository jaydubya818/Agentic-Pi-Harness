import { readFile } from "node:fs/promises";
import { PolicyDecisionSchema, PolicyDecision } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

/**
 * Level-C replay determinism: decision equivalence.
 * Two policy logs are decision-equivalent iff, for every toolCallId, both
 * runs reached the same `result` via the same `winningRuleId`.
 * Evaluation order and timestamps are ignored; provenanceMode must match.
 */

export interface DecisionDrift {
  ok: boolean;
  missing: string[];
  extra: string[];
  resultMismatches: Array<{ toolCallId: string; recorded: string; replayed: string }>;
  ruleMismatches: Array<{ toolCallId: string; recorded: string | null; replayed: string | null }>;
  provenanceMismatches: Array<{ toolCallId: string; recorded: string; replayed: string }>;
  hookDecisionMismatches: Array<{ toolCallId: string; recorded: string | null; replayed: string | null }>;
}

function hookSummary(decision: PolicyDecision): string | null {
  if (!decision.hookDecision) return null;
  const reason = decision.hookDecision.reason ? `:${decision.hookDecision.reason}` : "";
  return `${decision.hookDecision.decision}@${decision.hookDecision.hookId}${reason}`;
}

async function load(path: string): Promise<Map<string, PolicyDecision>> {
  const raw = await readFile(path, "utf8");
  const m = new Map<string, PolicyDecision>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const r = PolicyDecisionSchema.safeParse(JSON.parse(line));
    if (!r.success) throw new PiHarnessError("E_SCHEMA_PARSE", "policy log invalid", { issues: r.error.issues });
    m.set(r.data.toolCallId, r.data);
  }
  return m;
}

export async function diffDecisionLogs(recordedPath: string, replayedPath: string): Promise<DecisionDrift> {
  const a = await load(recordedPath);
  const b = await load(replayedPath);
  const drift: DecisionDrift = {
    ok: true, missing: [], extra: [],
    resultMismatches: [], ruleMismatches: [], provenanceMismatches: [], hookDecisionMismatches: [],
  };
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb) { drift.missing.push(id); continue; }
    if (ra.result !== rb.result) drift.resultMismatches.push({ toolCallId: id, recorded: ra.result, replayed: rb.result });
    if ((ra.winningRuleId ?? null) !== (rb.winningRuleId ?? null))
      drift.ruleMismatches.push({ toolCallId: id, recorded: ra.winningRuleId, replayed: rb.winningRuleId });
    if (ra.provenanceMode !== rb.provenanceMode)
      drift.provenanceMismatches.push({ toolCallId: id, recorded: ra.provenanceMode, replayed: rb.provenanceMode });
    if (hookSummary(ra) !== hookSummary(rb))
      drift.hookDecisionMismatches.push({ toolCallId: id, recorded: hookSummary(ra), replayed: hookSummary(rb) });
  }
  for (const id of b.keys()) if (!a.has(id)) drift.extra.push(id);
  drift.ok = !drift.missing.length && !drift.extra.length
    && !drift.resultMismatches.length && !drift.ruleMismatches.length && !drift.provenanceMismatches.length && !drift.hookDecisionMismatches.length;
  return drift;
}
