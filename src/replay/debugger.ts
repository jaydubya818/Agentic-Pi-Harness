import { readEffectLog } from "../effect/recorder.js";
import { readPolicyLog } from "../policy/decision.js";
import { readTape } from "./recorder.js";
import { EffectRecord, PolicyDecision, StreamEvent, TapeRecord } from "../schemas/index.js";

export interface ReplayDebugEntry {
  seq: number;
  event: StreamEvent;
  decision?: PolicyDecision;
  effect?: EffectRecord;
}

export async function buildReplayDebugTimeline(input: {
  tapePath: string;
  policyPath: string;
  effectPath?: string;
}): Promise<ReplayDebugEntry[]> {
  const tape = await readTape(input.tapePath);
  const decisions = new Map((await readPolicyLog(input.policyPath)).map((decision) => [decision.toolCallId, decision]));
  const effects = input.effectPath
    ? new Map((await readEffectLog(input.effectPath)).map((effect) => [effect.toolCallId, effect]))
    : new Map<string, EffectRecord>();

  return tape
    .filter((record): record is Extract<TapeRecord, { type: "event" }> => record.type === "event")
    .map((record) => {
      const event = record.event;
      if (event.type === "tool_use") {
        return {
          seq: record.seq,
          event,
          decision: decisions.get(event.id),
          effect: effects.get(event.id),
        };
      }
      if (event.type === "tool_result") {
        return {
          seq: record.seq,
          event,
          decision: decisions.get(event.id),
          effect: effects.get(event.id),
        };
      }
      return { seq: record.seq, event };
    });
}

export function renderReplayDebugTimeline(entries: ReplayDebugEntry[]): string {
  return entries.map((entry) => {
    const base = `[${entry.seq}] ${entry.event.type}`;
    if (entry.event.type === "tool_use") {
      const decision = entry.decision ? ` decision=${entry.decision.result}` : "";
      return `${base} ${entry.event.name}#${entry.event.id}${decision}`;
    }
    if (entry.event.type === "tool_result") {
      const effect = entry.effect ? ` effect=${entry.effect.toolName}` : "";
      return `${base} #${entry.event.id} isError=${entry.event.isError}${effect}`;
    }
    return base;
  }).join("\n");
}
