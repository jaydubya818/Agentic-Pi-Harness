import { ModelClient } from "../adapter/pi-adapter.js";
import { StreamEvent, EffectRecord, PolicyDecision, Checkpoint } from "../schemas/index.js";
import { ReplayRecorder } from "../replay/recorder.js";
import { EffectRecorder } from "../effect/recorder.js";
import { placeholderApprove } from "../policy/decision.js";
import { PolicyEngine } from "../policy/engine.js";
import { wrapToolOutput } from "./promptAssembly.js";
import { safeWriteJson } from "../session/provenance.js";
import { Counters } from "../metrics/counter.js";

export interface LoopInputs {
  sessionId: string;
  model: ModelClient;
  tape: ReplayRecorder;
  effects: EffectRecorder;
  checkpointPath: string;
  effectLogPath: string;
  policyLogPath: string;
  // Phase 1: trivial tool registry
  tools: Record<string, (input: any) => Promise<{ output: string; paths: string[] }>>;
  policy?: PolicyEngine;
  mode?: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
}

export interface LoopResult {
  events: StreamEvent[];
  effects: EffectRecord[];
  decisions: PolicyDecision[];
  counters: Record<string, number>;
}

/**
 * 5-phase async generator loop (Tier A minimal):
 *   1. Stream model events
 *   2. On tool_use → policy decision (placeholder)
 *   3. Snapshot pre-state
 *   4. Run tool → capture EffectRecord
 *   5. Wrap output and feed back as tool_result
 */
export async function runQueryLoop(inp: LoopInputs): Promise<LoopResult> {
  const counters = new Counters();
  const events: StreamEvent[] = [];
  const effects: EffectRecord[] = [];
  const decisions: PolicyDecision[] = [];
  let messageCount = 0;
  let stopReason: string | null = null;

  for await (const e of inp.model.stream([])) {
    events.push(e);
    await inp.tape.writeEvent(e);
    counters.inc("events." + e.type);

    if (e.type === "message_start") messageCount++;
    if (e.type === "message_stop") stopReason = e.stopReason;

    if (e.type === "tool_use") {
      const decision = inp.policy
        ? inp.policy.decide({ toolCallId: e.id, toolName: e.name, mode: inp.mode ?? "assist", input: e.input })
        : placeholderApprove(e.id);
      decisions.push(decision);
      await appendJsonl(inp.policyLogPath, decision);
      if (decision.result === "deny") {
        const denied: StreamEvent = {
          type: "tool_result", schemaVersion: 1, id: e.id,
          output: `denied by policy${decision.winningRuleId ? " (" + decision.winningRuleId + ")" : ""}`,
          isError: true,
        };
        events.push(denied);
        await inp.tape.writeEvent(denied);
        continue;
      }

      const tool = inp.tools[e.name];
      if (!tool) {
        const err: StreamEvent = {
          type: "tool_result", schemaVersion: 1, id: e.id,
          output: `unknown tool: ${e.name}`, isError: true,
        };
        events.push(err);
        await inp.tape.writeEvent(err);
        continue;
      }

      // Pre-snapshot: any declared path inputs. For v0.1 we expect { path }.
      const paths = extractPaths(e.input);
      await inp.effects.snapshotPre(paths);

      let rawOut = "";
      let isError = false;
      try {
        const r = await tool(e.input);
        rawOut = r.output;
        const rec = await inp.effects.capturePost(e.id, e.name, r.paths);
        effects.push(rec);
        await appendJsonl(inp.effectLogPath, rec);
      } catch (err) {
        isError = true;
        rawOut = `tool error: ${String((err as Error).message)}`;
      }

      const { wrapped } = wrapToolOutput(rawOut, {
        toolName: e.name, toolCallId: e.id, maxBytes: 64 * 1024,
      });
      const res: StreamEvent = { type: "tool_result", schemaVersion: 1, id: e.id, output: wrapped, isError };
      events.push(res);
      await inp.tape.writeEvent(res);
    }
  }

  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    sessionId: inp.sessionId,
    turnIndex: 0,
    messageCount,
    lastEventAt: new Date().toISOString(),
    stopReason,
  };
  await safeWriteJson(inp.checkpointPath, checkpoint);

  return { events, effects, decisions, counters: counters.snapshot() };
}

function extractPaths(input: unknown): string[] {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string") return [o.path];
    if (Array.isArray(o.paths)) return o.paths.filter((p): p is string => typeof p === "string");
  }
  return [];
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\n");
}
