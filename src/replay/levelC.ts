import { readFile } from "node:fs/promises";
import { PolicyDecisionSchema, PolicyDecision } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

/**
 * Level-C replay determinism: decision equivalence.
 * Two policy logs are decision-equivalent iff, for every toolCallId, both
 * runs reached the same `result` via the same `winningRuleId`.
 * Evaluation order and timestamps are ignored; provenanceMode must match.
 *
 * Scope limit, stated because the comparison reads stronger than it is: the
 * unit of comparison is the *toolCallId*, not the record. `load` folds each
 * log into a `Map` keyed by `toolCallId`, so when a log carries more than one
 * decision for the same id only the last survives, and the two record counts
 * are never compared. A replay that dropped a whole policy decision therefore
 * comes back `ok: true` with empty `missing` and `extra`.
 *
 * Reachable rather than theoretical: nothing dedupes tool-call ids. Every
 * `tool_use` event is pushed onto `pendingToolUses` in `src/loop/query.ts` and
 * each one gets its own `appendPolicyDecision`, so a model (or a replayed
 * tape) that emits the same `id` twice writes two records that this function
 * collapses into one. Reproduced: a recorded log of two decisions both under
 * `t1` against a replayed log holding only the second gives
 * `ok: true, missing: [], extra: []`.
 *
 * Same shape as the `postSet` fold documented on `diffEffectLogs`
 * (`src/replay/levelB.ts`), and left as-is for the same reason: keying by
 * `(recordIndex, toolCallId)` — or comparing record counts — makes Level C
 * assert a stronger replay contract than `docs/REPLAY-MODEL.md` specifies.
 * That is a contract decision, not a repair; see `docs/NIGHTLY-BACKLOG.md`.
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
  const lines = raw.split("\n").filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    let json: unknown;
    try {
      json = JSON.parse(lines[index]);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "policy log is not valid JSONL", { path, line: index + 1, cause: String(error) });
    }
    const r = PolicyDecisionSchema.safeParse(json);
    if (!r.success) throw new PiHarnessError("E_SCHEMA_PARSE", "policy log invalid", { path, line: index + 1, issues: r.error.issues });
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
