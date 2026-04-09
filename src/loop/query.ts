import { ModelClient } from "../adapter/pi-adapter.js";
import { Checkpoint, EffectRecord, PolicyDecision, StreamEvent } from "../schemas/index.js";
import { ReplayRecorder } from "../replay/recorder.js";
import { appendEffectRecord, EffectRecorder } from "../effect/recorder.js";
import { dispatchPostToolHooks, dispatchPreToolHooks, mergeHookDeniedDecision, RegisteredToolHook } from "../hooks/mediation.js";
import { appendPolicyDecision, decidePolicy, PolicyDecider, PolicyMode } from "../policy/decision.js";
import {
  classifyRetryableModelError,
  computeRetryDelayMs,
  normalizeRetryError,
  shouldRetryModelInvocation,
  sleep,
} from "../retry/stateMachine.js";
import { wrapToolOutput } from "./promptAssembly.js";
import { safeWriteJson } from "../session/provenance.js";
import { PiHarnessError } from "../errors.js";
import { compactHistory, CompactionRecord } from "../context/compaction.js";

export type LoopMode = "plan" | "assist" | "autonomous" | "worker" | "dry-run";

export interface LoopInputs {
  sessionId: string;
  model: ModelClient;
  tape: ReplayRecorder;
  effects: EffectRecorder;
  checkpointPath: string;
  effectLogPath: string;
  policyLogPath: string;
  tools: Record<string, (input: any) => Promise<{ output: string; paths: string[] }>>;
  policy?: PolicyDecider;
  policyMode?: PolicyMode;
  policyDigest?: string;
  mode?: LoopMode;
  tracePath?: string;
  hooks?: RegisteredToolHook[];
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  concurrency?: unknown;
  compactTargetBytes?: number;
  counters?: unknown;
  costTable?: unknown;
}

export interface LoopResult {
  events: StreamEvent[];
  compactedEvents: StreamEvent[];
  effects: EffectRecord[];
  decisions: PolicyDecision[];
  compactions: CompactionRecord[];
  counters: Record<string, number>;
  cost: null;
}

function createCounters() {
  const counts = new Map<string, number>();
  return {
    inc(key: string, by = 1) {
      counts.set(key, (counts.get(key) ?? 0) + by);
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries(counts);
    },
  };
}

function extractPaths(input: unknown): string[] {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string") return [record.path];
    if (Array.isArray(record.paths)) return record.paths.filter((path): path is string => typeof path === "string");
  }
  return [];
}

function isMutatingTool(toolName: string): boolean {
  return toolName === "write_file";
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\n", "utf8");
}

async function emitEvent(
  tape: ReplayRecorder,
  counters: ReturnType<typeof createCounters>,
  events: StreamEvent[],
  sessionId: string,
  tracePath: string | undefined,
  event: StreamEvent,
): Promise<void> {
  events.push(event);
  await tape.writeEvent(event);
  counters.inc(`events.${event.type}`);

  if (tracePath) {
    await appendJsonl(tracePath, {
      at: new Date().toISOString(),
      sessionId,
      event,
    });
  }
}

function modelIterator(model: ModelClient): AsyncIterator<StreamEvent> {
  const stream = model.stream([]);
  const factory = stream[Symbol.asyncIterator];
  if (typeof factory !== "function") {
    throw new PiHarnessError("E_MODEL_ADAPTER", "model.stream() did not return an async iterable", {}, { retryable: false });
  }
  return factory.call(stream);
}

function wrapModelInvocationFailure(error: unknown, input: {
  classification: string;
  attempt: number;
  maxAttempts: number;
  boundaryReason: "before_first_persisted_event" | "after_persisted_event";
}) {
  if (error instanceof PiHarnessError) {
    error.retryable = false;
    error.context = {
      ...error.context,
      retryClassification: input.classification,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      boundaryReason: input.boundaryReason,
      normalizedError: normalizeRetryError(error),
    };
    return error;
  }

  return new PiHarnessError(
    "E_MODEL_ADAPTER",
    `model invocation failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      retryClassification: input.classification,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      boundaryReason: input.boundaryReason,
      normalizedError: normalizeRetryError(error),
    },
    { retryable: false },
  );
}

function retryFailureCounterKey(input: {
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  attempt: number;
  classification: string;
}): "retry.exhausted" | "retry.fail_closed" {
  return input.classification === "model_open_transient" && !!input.retry && input.attempt >= input.retry.maxAttempts
    ? "retry.exhausted"
    : "retry.fail_closed";
}

async function processEvent(
  inp: LoopInputs,
  mode: LoopMode,
  counters: ReturnType<typeof createCounters>,
  events: StreamEvent[],
  effects: EffectRecord[],
  decisions: PolicyDecision[],
  event: StreamEvent,
): Promise<{ messageStarted: boolean; stopReason: string | null }> {
  await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, event);

  if (event.type === "message_start") {
    return { messageStarted: true, stopReason: null };
  }

  if (event.type === "message_stop") {
    return { messageStarted: false, stopReason: event.stopReason };
  }

  if (event.type !== "tool_use") {
    return { messageStarted: false, stopReason: null };
  }

  const baseDecision = decidePolicy({
    policyMode: inp.policyMode,
    policy: inp.policy,
    toolCallId: event.id,
    toolName: event.name,
    mode,
    input: event.input,
    policyDigest: inp.policyDigest,
  });

  let decision = baseDecision;
  if (decision.result !== "deny" && inp.hooks?.length) {
    const preHook = await dispatchPreToolHooks(inp.hooks, {
      event: "PreToolUse",
      sessionId: inp.sessionId,
      turnIndex: 0,
      payload: {
        toolCallId: event.id,
        toolName: event.name,
        mode,
        input: event.input,
        baseDecision: {
          result: baseDecision.result,
          provenanceMode: baseDecision.provenanceMode,
          winningRuleId: baseDecision.winningRuleId,
        },
      },
    });
    if (preHook.deniedBy) {
      decision = mergeHookDeniedDecision(baseDecision, preHook.deniedBy);
    }
  }

  decisions.push(decision);
  await appendPolicyDecision(inp.policyLogPath, decision);
  counters.inc(`policy.${decision.result}`);

  let toolResult: StreamEvent;

  if (decision.result === "deny") {
    counters.inc("tool.denied");
    const deniedByHook = decision.hookDecision ? ` (hook ${decision.hookDecision.hookId})` : "";
    toolResult = {
      type: "tool_result",
      schemaVersion: 1,
      id: event.id,
      output: `denied by policy${decision.winningRuleId ? ` (${decision.winningRuleId})` : ""}${deniedByHook}`,
      isError: true,
    };
    await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, toolResult);
    return { messageStarted: false, stopReason: null };
  }

  const tool = inp.tools[event.name];
  if (!tool) {
    counters.inc("tool.unknown");
    toolResult = {
      type: "tool_result",
      schemaVersion: 1,
      id: event.id,
      output: `unknown tool: ${event.name}`,
      isError: true,
    };
    await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, toolResult);
    return { messageStarted: false, stopReason: null };
  }

  let rawOutput = "";
  let isError = false;

  try {
    const paths = extractPaths(event.input);
    if (isMutatingTool(event.name)) {
      await inp.effects.snapshotPre(paths, event.id);
    }

    const result = await tool(event.input);
    rawOutput = result.output;

    if (isMutatingTool(event.name)) {
      const effect = await inp.effects.capturePost(inp.sessionId, event.id, event.name, result.paths);
      effects.push(effect);
      await appendEffectRecord(inp.effectLogPath, effect);
    }

    if (inp.hooks?.length) {
      await dispatchPostToolHooks(inp.hooks, {
        event: "PostToolUse",
        sessionId: inp.sessionId,
        turnIndex: 0,
        payload: {
          toolCallId: event.id,
          toolName: event.name,
          mode,
          input: event.input,
          isError: false,
          paths: result.paths,
        },
      });
    }
  } catch (error) {
    isError = true;
    rawOutput = `tool error: ${String((error as Error).message)}`;
    counters.inc("tool.error");
    if (inp.hooks?.length) {
      await dispatchPostToolHooks(inp.hooks, {
        event: "PostToolUse",
        sessionId: inp.sessionId,
        turnIndex: 0,
        payload: {
          toolCallId: event.id,
          toolName: event.name,
          mode,
          input: event.input,
          isError: true,
          paths: [],
        },
      });
    }
  }

  const { wrapped } = wrapToolOutput(rawOutput, {
    toolName: event.name,
    toolCallId: event.id,
    maxBytes: 64 * 1024,
  });

  toolResult = {
    type: "tool_result",
    schemaVersion: 1,
    id: event.id,
    output: wrapped,
    isError,
  };
  await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, toolResult);

  return { messageStarted: false, stopReason: null };
}

export async function runQueryLoop(inp: LoopInputs): Promise<LoopResult> {
  const mode = inp.mode ?? "assist";
  const counters = createCounters();
  const events: StreamEvent[] = [];
  const effects: EffectRecord[] = [];
  const decisions: PolicyDecision[] = [];
  let messageCount = 0;
  let stopReason: string | null = null;

  let attempt = 1;
  let completed = false;
  let retried = false;

  while (!completed) {
    let currentInvocationPersistedEvent = false;
    let iterator: AsyncIterator<StreamEvent>;

    try {
      iterator = modelIterator(inp.model);
    } catch (error) {
      const classification = classifyRetryableModelError(error, { hasPersistedEvent: false });
      counters.inc(`retry.class.${classification}`);
      if (shouldRetryModelInvocation({ retry: inp.retry, attempt, classification })) {
        counters.inc("retry.attempted");
        retried = true;
        await sleep(computeRetryDelayMs(attempt, inp.retry!.baseDelayMs, inp.retry!.maxDelayMs));
        attempt += 1;
        continue;
      }
      counters.inc(retryFailureCounterKey({ retry: inp.retry, attempt, classification }));
      throw wrapModelInvocationFailure(error, {
        classification,
        attempt,
        maxAttempts: inp.retry?.maxAttempts ?? 1,
        boundaryReason: "before_first_persisted_event",
      });
    }

    while (true) {
      let next: IteratorResult<StreamEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        const classification = classifyRetryableModelError(error, { hasPersistedEvent: currentInvocationPersistedEvent });
        const boundaryReason = currentInvocationPersistedEvent
          ? "after_persisted_event"
          : "before_first_persisted_event";
        counters.inc(`retry.class.${classification}`);

        if (shouldRetryModelInvocation({ retry: inp.retry, attempt, classification })) {
          counters.inc("retry.attempted");
          retried = true;
          await sleep(computeRetryDelayMs(attempt, inp.retry!.baseDelayMs, inp.retry!.maxDelayMs));
          attempt += 1;
          break;
        }

        counters.inc(retryFailureCounterKey({ retry: inp.retry, attempt, classification }));
        throw wrapModelInvocationFailure(error, {
          classification,
          attempt,
          maxAttempts: inp.retry?.maxAttempts ?? 1,
          boundaryReason,
        });
      }

      if (next.done) {
        completed = true;
        if (retried) counters.inc("retry.succeeded");
        break;
      }

      const event = next.value;
      const result = await processEvent(inp, mode, counters, events, effects, decisions, event);
      currentInvocationPersistedEvent = true;
      if (result.messageStarted) {
        messageCount += 1;
      }
      if (result.stopReason) {
        stopReason = result.stopReason;
      }
    }
  }

  let compactedEvents = events;
  let compactions: CompactionRecord[] = [];
  if (typeof inp.compactTargetBytes === "number") {
    const compaction = compactHistory(events, { targetBytes: inp.compactTargetBytes });
    compactedEvents = compaction.events;
    if (compaction.record) {
      compactions = [compaction.record];
      counters.inc("compaction.applied");
      counters.inc("compaction.tool_results", compaction.record.compactedToolCallIds.length);
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

  return {
    events,
    compactedEvents,
    effects,
    decisions,
    compactions,
    counters: counters.snapshot(),
    cost: null,
  };
}
