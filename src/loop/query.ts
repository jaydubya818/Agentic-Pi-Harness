import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import { ConcurrencyClassifier, scheduleCalls, ScheduledCall } from "../tools/concurrency.js";
import {
  ApprovalDecision,
  ApprovalPacket,
  ApprovalRequester,
  applyApprovalDecision,
  createApprovalPacket,
  requestApprovalDecision,
} from "../approvals/runtime.js";
import { evaluateWorkerToolUse, validateWorkerModeInputs, WorkerModeControls } from "../runtime/workerControls.js";
import { Counters, CountersSink } from "../metrics/counter.js";
import { CostRecord, CostTable, CostTracker } from "../metrics/cost.js";
import { SofieAnswer, SofieContext, SofieToolEvidence, answerRoutineQuestion, makeApprovalSummaries } from "../sofie/authority.js";

export type LoopMode = "plan" | "assist" | "autonomous" | "worker" | "dry-run";
type ToolUseEvent = Extract<StreamEvent, { type: "tool_use" }>;

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
  approvalRequester?: ApprovalRequester;
  approvalTimeoutMs?: number;
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  concurrency?: ConcurrencyClassifier;
  compactTargetBytes?: number;
  workerControls?: WorkerModeControls;
  sofie?: {
    enabled: boolean;
    question?: string;
    kind?: SofieContext["kind"];
    frictionFindings?: string[];
  };
  /** Optional metrics sink (e.g. FanOutCounters with an OTel sink); the loop increments it in real time and snapshots it into LoopResult. */
  counters?: CountersSink;
  /** Optional cost table; when set, LoopResult.cost carries a CostRecord estimated from the emitted event stream. */
  costTable?: CostTable;
}

export interface LoopResult {
  events: StreamEvent[];
  compactedEvents: StreamEvent[];
  effects: EffectRecord[];
  decisions: PolicyDecision[];
  compactions: CompactionRecord[];
  approvalPackets: ApprovalPacket[];
  approvalDecisions: ApprovalDecision[];
  sofieAnswer: SofieAnswer | null;
  counters: Record<string, number>;
  cost: CostRecord | null;
}

interface PreparedToolDispatch {
  toolEvent: ToolUseEvent;
  order: number;
  immediateResult?: StreamEvent;
  scheduledCall?: ScheduledCall<StreamEvent>;
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

/**
 * Trace directories already created in this process. appendJsonl runs once
 * per emitted event, and the recursive mkdir it used to issue every time was
 * a pure syscall tax after the first line of a session: the directory is the
 * same for the whole run. Bounded so a long-lived supervisor process that
 * runs many sessions cannot accumulate paths forever.
 */
const ensuredJsonlDirs = new Set<string>();
const MAX_ENSURED_JSONL_DIRS = 1024;

async function ensureJsonlDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (ensuredJsonlDirs.size >= MAX_ENSURED_JSONL_DIRS) ensuredJsonlDirs.clear();
  ensuredJsonlDirs.add(dir);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const line = JSON.stringify(value) + "\n";
  if (!ensuredJsonlDirs.has(dir)) await ensureJsonlDir(dir);
  try {
    await appendFile(path, line, "utf8");
  } catch (error) {
    // The trace directory can disappear underneath a cached entry (a test
    // tmpdir teardown, an operator clearing an out root mid-run). Re-create
    // it and retry once instead of failing the whole turn.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ensureJsonlDir(dir);
    await appendFile(path, line, "utf8");
  }
}

async function emitEvent(
  tape: ReplayRecorder,
  counters: CountersSink,
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

function resolveConcurrencyClassifier(value: LoopInputs["concurrency"]): ConcurrencyClassifier | null {
  return value instanceof ConcurrencyClassifier ? value : null;
}

function deniedToolResult(event: ToolUseEvent, decision: PolicyDecision): StreamEvent {
  const deniedByHook = decision.hookDecision ? ` (hook ${decision.hookDecision.hookId})` : "";
  return {
    type: "tool_result",
    schemaVersion: 1,
    id: event.id,
    output: `denied by policy${decision.winningRuleId ? ` (${decision.winningRuleId})` : ""}${deniedByHook}`,
    isError: true,
  };
}

function unknownToolResult(event: ToolUseEvent): StreamEvent {
  return {
    type: "tool_result",
    schemaVersion: 1,
    id: event.id,
    output: `unknown tool: ${event.name}`,
    isError: true,
  };
}

async function executeApprovedTool(
  inp: LoopInputs,
  mode: LoopMode,
  counters: CountersSink,
  effects: EffectRecord[],
  event: ToolUseEvent,
): Promise<StreamEvent> {
  const tool = inp.tools[event.name];
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
    rawOutput = `tool error: ${error instanceof Error ? error.message : String(error)}`;
    counters.inc("tool.error");
    if (isMutatingTool(event.name)) {
      // capturePost never ran, so release the pre-snapshot scope; otherwise
      // every failing mutating call leaks its retained file text for the
      // rest of the session.
      inp.effects.discard(event.id);
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

  return {
    type: "tool_result",
    schemaVersion: 1,
    id: event.id,
    output: wrapped,
    isError,
  };
}

async function prepareToolDispatch(
  inp: LoopInputs,
  mode: LoopMode,
  counters: CountersSink,
  effects: EffectRecord[],
  decisions: PolicyDecision[],
  approvalPackets: ApprovalPacket[],
  approvalDecisions: ApprovalDecision[],
  event: ToolUseEvent,
  order: number,
): Promise<PreparedToolDispatch> {
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

  if (decision.result === "ask") {
    const packet = createApprovalPacket({
      sessionId: inp.sessionId,
      decision,
      toolName: event.name,
      timeoutMs: inp.approvalTimeoutMs ?? 30_000,
    });
    approvalPackets.push(packet);
    const approval = await requestApprovalDecision({
      packet,
      requester: inp.approvalRequester,
      timeoutMs: inp.approvalTimeoutMs ?? packet.timeoutMs,
    });
    approvalDecisions.push(approval);
    counters.inc(`approval.${approval.outcome}`);
    decision = applyApprovalDecision(decision, approval);
  }

  const classifier = resolveConcurrencyClassifier(inp.concurrency) ?? new ConcurrencyClassifier([]);
  const workerDecision = evaluateWorkerToolUse({
    mode,
    workerControls: inp.workerControls,
    toolName: event.name,
    toolClass: classifier.classify(event.name),
    toolInput: event.input,
  });
  if (!workerDecision.allowed) {
    decision = {
      ...decision,
      result: "deny",
      manifestInfluence: workerDecision.manifestInfluence,
    };
  }

  decisions.push(decision);
  await appendPolicyDecision(inp.policyLogPath, decision);
  counters.inc(`policy.${decision.result}`);

  if (decision.result === "deny") {
    counters.inc("tool.denied");
    return {
      toolEvent: event,
      order,
      immediateResult: deniedToolResult(event, decision),
    };
  }

  const tool = inp.tools[event.name];
  if (!tool) {
    counters.inc("tool.unknown");
    return {
      toolEvent: event,
      order,
      immediateResult: unknownToolResult(event),
    };
  }

  return {
    toolEvent: event,
    order,
    scheduledCall: {
      id: event.id,
      name: event.name,
      order,
      run: () => executeApprovedTool(inp, mode, counters, effects, event),
    },
  };
}

async function emitNonToolEvent(
  inp: LoopInputs,
  counters: CountersSink,
  events: StreamEvent[],
  event: Exclude<StreamEvent, { type: "tool_use" }>,
): Promise<{ messageStarted: boolean; stopReason: string | null }> {
  await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, event);
  if (event.type === "message_start") {
    return { messageStarted: true, stopReason: null };
  }
  if (event.type === "message_stop") {
    return { messageStarted: false, stopReason: event.stopReason };
  }
  return { messageStarted: false, stopReason: null };
}

async function flushPendingToolUses(
  inp: LoopInputs,
  mode: LoopMode,
  counters: CountersSink,
  events: StreamEvent[],
  effects: EffectRecord[],
  decisions: PolicyDecision[],
  approvalPackets: ApprovalPacket[],
  approvalDecisions: ApprovalDecision[],
  pendingToolUses: ToolUseEvent[],
): Promise<void> {
  if (pendingToolUses.length === 0) return;

  const prepared: PreparedToolDispatch[] = [];
  for (let index = 0; index < pendingToolUses.length; index++) {
    prepared.push(await prepareToolDispatch(inp, mode, counters, effects, decisions, approvalPackets, approvalDecisions, pendingToolUses[index], index));
  }

  const scheduled = prepared
    .filter((entry): entry is PreparedToolDispatch & { scheduledCall: ScheduledCall<StreamEvent> } => !!entry.scheduledCall)
    .map((entry) => entry.scheduledCall);

  const scheduledResults = new Map<string, StreamEvent>();
  if (scheduled.length > 0) {
    const classifier = resolveConcurrencyClassifier(inp.concurrency);
    if (classifier) {
      const results = await scheduleCalls(scheduled, classifier);
      for (const scheduledResult of results) {
        if (scheduledResult.result.status === "rejected") {
          throw scheduledResult.result.reason;
        }
        scheduledResults.set(scheduledResult.call.id, scheduledResult.result.value);
      }
    } else {
      for (const call of scheduled) {
        scheduledResults.set(call.id, await call.run());
      }
    }
  }

  for (const entry of prepared) {
    const toolResult = entry.immediateResult ?? scheduledResults.get(entry.toolEvent.id);
    if (!toolResult) {
      throw new PiHarnessError("E_UNKNOWN", "scheduled tool result missing", {
        toolCallId: entry.toolEvent.id,
        toolName: entry.toolEvent.name,
      });
    }
    await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, toolResult);
  }

  pendingToolUses.length = 0;
}

export async function runQueryLoop(inp: LoopInputs): Promise<LoopResult> {
  const mode = inp.mode ?? "assist";
  validateWorkerModeInputs({
    mode,
    workerControls: inp.workerControls,
    approvalRequesterConfigured: !!inp.approvalRequester,
  });

  // Honor a caller-provided sink (docs in metrics/counter.ts + metrics/otel.ts
  // promise real-time increments through `counters`); default stays in-memory.
  const counters: CountersSink = inp.counters ?? new Counters();
  const events: StreamEvent[] = [];
  const effects: EffectRecord[] = [];
  const decisions: PolicyDecision[] = [];
  const approvalPackets: ApprovalPacket[] = [];
  const approvalDecisions: ApprovalDecision[] = [];
  const pendingToolUses: ToolUseEvent[] = [];
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
        await flushPendingToolUses(inp, mode, counters, events, effects, decisions, approvalPackets, approvalDecisions, pendingToolUses);
        completed = true;
        if (retried) counters.inc("retry.succeeded");
        break;
      }

      const event = next.value;
      if (event.type === "tool_use") {
        await emitEvent(inp.tape, counters, events, inp.sessionId, inp.tracePath, event);
        pendingToolUses.push(event);
        currentInvocationPersistedEvent = true;
        continue;
      }

      await flushPendingToolUses(inp, mode, counters, events, effects, decisions, approvalPackets, approvalDecisions, pendingToolUses);
      const nonTool = await emitNonToolEvent(inp, counters, events, event);
      currentInvocationPersistedEvent = true;
      if (nonTool.messageStarted) {
        messageCount += 1;
      }
      if (nonTool.stopReason) {
        stopReason = nonTool.stopReason;
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

  const toolNamesByCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool_use") toolNamesByCallId.set(event.id, event.name);
  }
  const effectPathsByCallId = new Map(effects.map((effect) => [effect.toolCallId, effect.paths]));
  const sofieToolEvidence: SofieToolEvidence[] = decisions.map((decision) => ({
    toolCallId: decision.toolCallId,
    toolName: toolNamesByCallId.get(decision.toolCallId) ?? "unknown",
    result: decision.result,
    paths: effectPathsByCallId.get(decision.toolCallId) ?? [],
  }));

  const sofieAnswer = inp.sofie?.enabled
    ? answerRoutineQuestion({
        sessionId: inp.sessionId,
        mode,
        question: inp.sofie.question ?? "Provide bounded internal operator guidance.",
        kind: inp.sofie.kind ?? "operator",
        tapeEventTypes: events.map((event) => event.type),
        effects,
        decisions,
        toolEvidence: sofieToolEvidence,
        approvals: makeApprovalSummaries(approvalDecisions),
        provenance: { policyDigest: inp.policyDigest ?? null },
        frictionFindings: inp.sofie.frictionFindings,
      })
    : null;

  let cost: CostRecord | null = null;
  if (inp.costTable) {
    const tracker = new CostTracker(inp.costTable);
    for (const event of events) tracker.observe(event);
    cost = tracker.snapshot();
  }

  return {
    events,
    compactedEvents,
    effects,
    decisions,
    compactions,
    approvalPackets,
    approvalDecisions,
    sofieAnswer,
    counters: counters.snapshot(),
    cost,
  };
}
