import { ModelClient } from "../adapter/pi-adapter.js";
import { StreamEvent, EffectRecord, PolicyDecision, Checkpoint } from "../schemas/index.js";
import { ReplayRecorder } from "../replay/recorder.js";
import { EffectRecorder, EffectScope } from "../effect/recorder.js";
import { placeholderApprove } from "../policy/decision.js";
import { PolicyEngine } from "../policy/engine.js";
import { wrapToolOutput } from "./promptAssembly.js";
import { safeWriteJson } from "../session/provenance.js";
import { Counters, CountersSink } from "../metrics/counter.js";
import { CostTable, CostTracker, CostRecord } from "../metrics/cost.js";
import { compact, CompactionRecord } from "../context/compaction.js";
import { withRetry, defaultClassify } from "../retry/stateMachine.js";
import { ConcurrencyClassifier, schedule, PendingCall } from "../tools/concurrency.js";

export interface LoopInputs {
  sessionId: string;
  model: ModelClient;
  tape: ReplayRecorder;
  effects: EffectRecorder;
  checkpointPath: string;
  effectLogPath: string;
  policyLogPath: string;
  tools: Record<string, (input: any) => Promise<{ output: string; paths: string[] }>>;
  policy?: PolicyEngine;
  mode?: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  concurrency?: ConcurrencyClassifier;
  compactTargetBytes?: number;
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  /**
   * Optional JSONL trace sink. If set, every stream event is appended as a
   * single JSON line with a wall-clock timestamp. Useful for debugging
   * retries, compaction thresholds, and tool scheduling. Trace events are
   * ADDITIONAL audit output; they do not replace the tape.
   */
  tracePath?: string;
  /**
   * Optional pluggable counters sink. Defaults to in-memory `Counters`.
   * Supply `FanOutCounters([new Counters(), await createOtelCounters()])`
   * to mirror every increment into OpenTelemetry.
   */
  counters?: CountersSink;
  /**
   * Optional cost table for per-stream USD accounting. If set, a CostTracker
   * is built and every text_delta + tool_result is observed. The final
   * `LoopResult.cost` is the snapshot at loop exit.
   */
  costTable?: CostTable;
}

export interface LoopResult {
  events: StreamEvent[];                  // faithful record of what was emitted to tape
  compactedEvents: StreamEvent[];         // for feeding the next model turn (never written to tape)
  effects: EffectRecord[];
  decisions: PolicyDecision[];
  compactions: CompactionRecord[];
  counters: Record<string, number>;
  cost: CostRecord | null;
}

/**
 * Tier B loop. Design invariants:
 *   - Retry wraps a single `iter.next()` call. Events already appended to
 *     the tape are never re-appended on retry.
 *   - Concurrent tool calls get disjoint EffectScopes keyed by toolCallId,
 *     so two writes to the same path cannot clobber each other's pre-state.
 *   - `events` is the faithful tape record and is never mutated after a
 *     record lands. Compaction produces a separate `compactedEvents` view
 *     for the next model turn's prompt assembly.
 *   - Every scheduled closure has an unconditional catch so a thrown tool
 *     always produces a tool_result on the tape.
 */
export async function runQueryLoop(inp: LoopInputs): Promise<LoopResult> {
  const counters: CountersSink = inp.counters ?? new Counters();
  const costTracker: CostTracker | null = inp.costTable ? new CostTracker(inp.costTable) : null;
  const events: StreamEvent[] = [];
  const effects: EffectRecord[] = [];
  const decisions: PolicyDecision[] = [];
  const compactions: CompactionRecord[] = [];
  const targetBytes = inp.compactTargetBytes ?? 64 * 1024;
  let messageCount = 0;
  let stopReason: string | null = null;
  const cc = inp.concurrency;
  const mode = inp.mode ?? "assist";
  const retryCfg = inp.retry ?? { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 200 };

  const emit = async (e: StreamEvent): Promise<void> => {
    events.push(e);
    await inp.tape.writeEvent(e);
    counters.inc("events." + e.type);
    if (costTracker) costTracker.observe(e);
    if (inp.tracePath) {
      await appendJsonl(inp.tracePath, {
        at: new Date().toISOString(),
        sessionId: inp.sessionId,
        event: e,
      });
    }
  };

  const flushBatch = async (batch: Extract<StreamEvent, { type: "tool_use" }>[]) => {
    if (batch.length === 0) return;
    const calls: PendingCall[] = [];
    const resultsById = new Map<string, StreamEvent>();

    for (const tu of batch) {
      const decision = inp.policy
        ? inp.policy.decide({ toolCallId: tu.id, toolName: tu.name, mode, input: tu.input })
        : placeholderApprove(tu.id);
      decisions.push(decision);
      await appendJsonl(inp.policyLogPath, decision);
      counters.inc("policy." + decision.result);

      if (decision.result === "deny") {
        resultsById.set(tu.id, {
          type: "tool_result", schemaVersion: 1, id: tu.id,
          output: `denied by policy${decision.winningRuleId ? " (" + decision.winningRuleId + ")" : ""}`,
          isError: true,
        });
        counters.inc("tool.denied");
        continue;
      }

      const tool = inp.tools[tu.name];
      if (!tool) {
        resultsById.set(tu.id, {
          type: "tool_result", schemaVersion: 1, id: tu.id,
          output: `unknown tool: ${tu.name}`, isError: true,
        });
        counters.inc("tool.unknown");
        continue;
      }

      // Per-call EffectScope — disjoint state, safe under concurrency.
      const scope: EffectScope = inp.effects.scope();

      calls.push({
        id: tu.id, name: tu.name,
        run: async () => {
          let rawOut = "";
          let isError = false;
          try {
            const paths = extractPaths(tu.input);
            await scope.snapshotPre(paths);
            const r = await tool(tu.input);
            rawOut = r.output;
            const rec = await scope.capturePost(tu.id, tu.name, r.paths);
            effects.push(rec);
            await appendJsonl(inp.effectLogPath, rec);
          } catch (err) {
            // Unconditional catch: a thrown tool always produces a result.
            isError = true;
            rawOut = `tool error: ${String((err as Error).message)}`;
            counters.inc("tool.error");
          }
          const { wrapped } = wrapToolOutput(rawOut, {
            toolName: tu.name, toolCallId: tu.id, maxBytes: 64 * 1024,
          });
          resultsById.set(tu.id, {
            type: "tool_result", schemaVersion: 1, id: tu.id, output: wrapped, isError,
          });
        },
      });
    }

    if (cc) await schedule(calls, cc);
    else for (const c of calls) await c.run();

    // Preserve original tool_use order.
    for (const tu of batch) {
      const res = resultsById.get(tu.id);
      if (res) await emit(res);
    }
  };

  // Manual stream iteration — retry is per-chunk, not per-stream.
  const iter = inp.model.stream([])[Symbol.asyncIterator]();
  let toolBatch: Extract<StreamEvent, { type: "tool_use" }>[] = [];

  while (true) {
    const step = await withRetry(
      async () => iter.next(),
      { ...retryCfg, classify: defaultClassify },
    );
    if (step.done) break;
    const e = step.value;

    if (e.type === "tool_use") {
      toolBatch.push(e);
      await emit(e);
      continue;
    }

    // Any non-tool event flushes the batch first (preserves stream order).
    if (toolBatch.length) {
      const b = toolBatch;
      toolBatch = [];
      await flushBatch(b);
    }

    await emit(e);

    if (e.type === "message_start") messageCount++;
    if (e.type === "message_stop") stopReason = e.stopReason;
  }
  if (toolBatch.length) {
    const b = toolBatch;
    toolBatch = [];
    await flushBatch(b);
  }

  // Compaction: produce a separate view for the next turn's prompt. Never
  // mutates `events`, so the tape and in-memory record stay in sync.
  let compactedEvents = events;
  if (Buffer.byteLength(JSON.stringify(events), "utf8") > targetBytes) {
    const { events: c, record } = compact(events, { targetBytes });
    compactedEvents = c;
    compactions.push(record);
    counters.inc("compactions");
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

  const cost = costTracker ? costTracker.snapshot() : null;
  if (cost) {
    counters.inc("cost.inputTokens", cost.inputTokens);
    counters.inc("cost.outputTokens", cost.outputTokens);
    counters.inc("cost.micros_usd", Math.round(cost.usd * 1e6));
  }
  return { events, compactedEvents, effects, decisions, compactions, counters: counters.snapshot(), cost };
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
