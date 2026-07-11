import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveKnowledgeRoots } from "../hermes/kbAccessPolicy.js";
import { safeWriteJson } from "../session/provenance.js";
import type { McClaimableWorkOrder, McClient } from "./client.js";
import type { McConfig } from "./config.js";
import { defaultMcStateDir, type McIdentity } from "./identity.js";
import { buildSessionLogRefs } from "./sessionLogs.js";
import {
  artifactKey,
  claimKey,
  expectedWorkOrderState,
  isMcBridgeExecutionState,
  isTerminalMcBridgeState,
  runKey,
  stateKey,
  type McBridgeExecutionState,
} from "./stateMap.js";

const RUN_POLL_MS = 750;
const MAX_ARTIFACT_CONTENT_BYTES = 256 * 1024;

// ── Structural view of the running bridge (no runtime import of httpBridge) ─

export interface McBridgeRunView {
  status: string;
  state?: string;
  error: string | null;
  result: { status: string; summary: string; artifacts: Array<{ type: string; path: string }> } | null;
  session: { session_id: string; hermes_session_id: string | null };
}

export interface McBridgeLike {
  stateRoot: string;
  startExternalSession(workdir: string, options?: { profile?: string }): Promise<{ session_id: string }>;
  submitExternalTask(request: Record<string, unknown>): Promise<{ execution_id: string }>;
  getRun(executionId: string): McBridgeRunView | null;
}

// ── Persistent, monotonically increasing seq per (workOrder, bridgeRun) ─────

interface McSeqFile {
  seqs: Record<string, number>;
}

/**
 * Sequence numbers for reportExecutionEvent, persisted so a restarted
 * adapter never reuses a seq (the pib:state idempotency key embeds it).
 */
export class McSeqStore {
  private readonly path: string;
  private seqs: Record<string, number> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async next(workOrderId: string, bridgeRunId: string): Promise<number> {
    if (this.seqs === null) this.seqs = await this.loadSeqs();
    const key = `${workOrderId}:${bridgeRunId}`;
    const next = (this.seqs[key] ?? 0) + 1;
    this.seqs[key] = next;
    await safeWriteJson(this.path, { seqs: this.seqs } satisfies McSeqFile);
    return next;
  }

  private async loadSeqs(): Promise<Record<string, number>> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<McSeqFile>;
      return raw.seqs && typeof raw.seqs === "object" ? raw.seqs : {};
    } catch {
      return {};
    }
  }
}

// ── Bridge run → MC bridge-state normalization ──────────────────────────────

/**
 * Normalize a bridge run record onto the 9-state MC executor contract.
 * Returns null for states MC does not model (queued/waiting_approval/blocked).
 */
export function toMcBridgeState(view: Pick<McBridgeRunView, "status" | "state" | "error">): McBridgeExecutionState | null {
  const candidate = view.state ?? legacyStatusToBridgeState(view.status, view.error);
  if (candidate && isMcBridgeExecutionState(candidate)) return candidate;
  return null;
}

function legacyStatusToBridgeState(status: string, error: string | null): string | null {
  switch (status) {
    case "accepted": return "accepted";
    case "running": return "running";
    case "completed": return "succeeded";
    case "failed": return error && /timed out/i.test(error) ? "timed_out" : "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    default: return null;
  }
}

// ── Dispatch loop ───────────────────────────────────────────────────────────

export interface DispatchLoopHandle {
  stop(): void;
}

export interface StartDispatchLoopOptions {
  client: McClient;
  config: McConfig;
  bridge: McBridgeLike;
  identity: McIdentity;
  stateDir?: string;
  isClaimingPaused?: () => boolean;
  warn?: (message: string) => void;
  info?: (message: string) => void;
  agenticKbRoot?: string;
  defaultTimeoutSeconds?: number;
}

/**
 * Poll Mission Control for claimable work orders and execute them one at a
 * time through the existing Hermes bridge execution path. Every state
 * transition, artifact, and terminal run is reported back with deterministic
 * pib:* idempotency keys so replays are safe.
 */
export function startDispatchLoop(options: StartDispatchLoopOptions): DispatchLoopHandle {
  const stateDir = options.stateDir ?? defaultMcStateDir();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const info = options.info ?? ((message: string) => console.log(message));
  const seqStore = new McSeqStore(join(stateDir, "mc-dispatch-seq.json"));
  let busy = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    if (options.isClaimingPaused?.()) return;
    busy = true;
    try {
      const claimable = await options.client.listClaimable(1);
      const workOrder = claimable[0];
      if (workOrder) {
        await runClaimedWorkOrder({ ...options, stateDir, warn, info, seqStore, workOrder, isStopped: () => stopped });
      }
    } catch (error) {
      warn(`[mc-adapter] dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, options.config.claimPollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

interface RunWorkOrderContext extends StartDispatchLoopOptions {
  stateDir: string;
  warn: (message: string) => void;
  info: (message: string) => void;
  seqStore: McSeqStore;
  workOrder: McClaimableWorkOrder;
  isStopped: () => boolean;
}

async function runClaimedWorkOrder(ctx: RunWorkOrderContext): Promise<void> {
  const { workOrder, client, identity } = ctx;
  const attempt = (workOrder.claimAttempt ?? 0) + 1;
  const executionId = `pi-${workOrder._id}-${attempt}`;

  const claim = await client.claimForExecutor({
    workOrderId: workOrder._id,
    agentId: identity.workerId,
    executionId,
    idempotencyKey: claimKey(workOrder._id, attempt),
  });
  if (!claim.claimed) {
    ctx.info(`[mc-adapter] work order not claimed (${claim.reason ?? "unknown"}): ${workOrder.title}`);
    return;
  }
  ctx.info(`[mc-adapter] claimed work order "${workOrder.title}" (attempt ${claim.attempt ?? attempt})`);

  const bridgeRunId = `pib_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const outputDir = buildMissionOutputDir(workOrder._id, bridgeRunId, ctx.agenticKbRoot);
  const timeoutSeconds = resolveTimeoutSeconds(workOrder, ctx.defaultTimeoutSeconds);

  try {
    const session = await ctx.bridge.startExternalSession(resolveWorkdir(workOrder));
    await ctx.bridge.submitExternalTask({
      request_id: `mc_${workOrder._id}_${attempt}`,
      session_id: session.session_id,
      execution_id: bridgeRunId,
      objective: buildObjective(workOrder),
      workdir: resolveWorkdir(workOrder),
      allowed_tools: [],
      allowed_actions: ["read", "write"],
      timeout_seconds: timeoutSeconds,
      output_dir: outputDir,
      metadata: {
        mission_id: `mc-${workOrder._id}`,
        run_id: bridgeRunId,
        step_id: `attempt-${attempt}`,
      },
    });
    await watchBridgeRun(ctx, { attempt, executionId, bridgeRunId, outputDir, timeoutSeconds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.warn(`[mc-adapter] execution failed for "${workOrder.title}": ${message}`);
    await reportState(ctx, {
      bridgeState: "failed",
      bridgeRunId,
      executionId,
      hermesSessionId: null,
      summary: `Bridge submission failed: ${message}`,
    }).catch(() => undefined);
  }
}

interface BridgeRunRefs {
  attempt: number;
  executionId: string;
  bridgeRunId: string;
  outputDir: string;
  timeoutSeconds: number;
}

async function watchBridgeRun(ctx: RunWorkOrderContext, refs: BridgeRunRefs): Promise<void> {
  const deadline = Date.now() + refs.timeoutSeconds * 1000 + 60_000;
  let lastReported: McBridgeExecutionState | null = null;
  let terminal: McBridgeExecutionState | null = null;

  while (!ctx.isStopped()) {
    const run = ctx.bridge.getRun(refs.bridgeRunId);
    const current = run ? toMcBridgeState(run) : null;
    if (current && current !== lastReported) {
      await reportState(ctx, {
        bridgeState: current,
        bridgeRunId: refs.bridgeRunId,
        executionId: refs.executionId,
        hermesSessionId: run?.session.hermes_session_id ?? null,
        summary: run?.result?.summary || undefined,
      });
      lastReported = current;
      if (isTerminalMcBridgeState(current)) {
        terminal = current;
        break;
      }
    }
    if (Date.now() > deadline) {
      await reportState(ctx, {
        bridgeState: "timed_out",
        bridgeRunId: refs.bridgeRunId,
        executionId: refs.executionId,
        hermesSessionId: run?.session.hermes_session_id ?? null,
        summary: "Adapter watch deadline exceeded",
      });
      terminal = "timed_out";
      break;
    }
    await delay(RUN_POLL_MS);
  }

  if (terminal) await finalizeRun(ctx, refs, terminal);
}

async function finalizeRun(ctx: RunWorkOrderContext, refs: BridgeRunRefs, terminal: McBridgeExecutionState): Promise<void> {
  const run = ctx.bridge.getRun(refs.bridgeRunId);
  const hermesSessionId = run?.session.hermes_session_id ?? undefined;

  if (terminal === "succeeded" && run?.result?.artifacts) {
    for (const artifact of run.result.artifacts) {
      await recordArtifact(ctx, artifact).catch((error) => {
        ctx.warn(`[mc-adapter] artifact record failed for ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  const sessionLogRefs = await buildSessionLogRefs(
    [
      { kind: "BRIDGE_EVENTS", path: join(ctx.bridge.stateRoot, "runs", refs.bridgeRunId, "events.jsonl") },
      { kind: "HERMES_SESSION", path: join(refs.outputDir, ".pi-hermes", "hermes.raw.log") },
    ],
    { excerptMaxBytes: ctx.config.sessionLogExcerptMaxBytes },
  );

  const mcRunId = await ctx.client.startRun({
    agentId: ctx.identity.workerId,
    sessionKey: `pi-bridge:${refs.bridgeRunId}`,
    model: "hermes",
    idempotencyKey: runKey(ctx.workOrder._id, refs.bridgeRunId),
    metadata: {
      workOrderId: ctx.workOrder._id,
      executionId: refs.executionId,
      bridgeRunId: refs.bridgeRunId,
      hermesSessionId: hermesSessionId ?? null,
    },
  });
  await ctx.client.completeRun({
    runId: mcRunId,
    status: terminal === "succeeded" ? "COMPLETED" : terminal === "timed_out" ? "TIMEOUT" : "FAILED",
    sessionLogRefs,
    error: terminal === "succeeded" ? undefined : run?.error ?? undefined,
  });
  ctx.info(`[mc-adapter] work order "${ctx.workOrder.title}" finished: ${terminal}`);
}

async function recordArtifact(ctx: RunWorkOrderContext, artifact: { type: string; path: string }): Promise<void> {
  let buffer: Buffer;
  try {
    buffer = await readFile(artifact.path);
  } catch {
    return;
  }
  const truncated = buffer.byteLength > MAX_ARTIFACT_CONTENT_BYTES;
  const content = truncated
    ? `${buffer.subarray(0, MAX_ARTIFACT_CONTENT_BYTES).toString("utf8")}\n\n[truncated by mc-adapter at ${MAX_ARTIFACT_CONTENT_BYTES} bytes]`
    : buffer.toString("utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const artifactId = `${basename(artifact.path)}@${sha256.slice(0, 16)}`;
  await ctx.client.recordExecutorArtifact({
    workOrderId: ctx.workOrder._id,
    agentId: ctx.identity.workerId,
    artifactId,
    title: basename(artifact.path),
    content,
    sha256,
    contentType: artifact.type,
    idempotencyKey: artifactKey(ctx.workOrder._id, artifactId),
  });
}

async function reportState(
  ctx: RunWorkOrderContext,
  input: {
    bridgeState: McBridgeExecutionState;
    bridgeRunId: string;
    executionId: string;
    hermesSessionId: string | null;
    summary?: string;
  },
): Promise<void> {
  const seq = await ctx.seqStore.next(ctx.workOrder._id, input.bridgeRunId);
  const response = await ctx.client.reportExecutionEvent({
    workOrderId: ctx.workOrder._id,
    agentId: ctx.identity.workerId,
    bridgeState: input.bridgeState,
    seq,
    bridgeRunId: input.bridgeRunId,
    idempotencyKey: stateKey(ctx.workOrder._id, input.bridgeRunId, seq),
    summary: input.summary,
    hermesSessionId: input.hermesSessionId ?? undefined,
    metadata: { executionId: input.executionId },
  });

  // Drift detection: MC owns the state machine; we only mirror it. succeeded
  // may legitimately land on AWAITING_VERIFICATION or DONE depending on MC's
  // verification status, which the adapter does not track.
  const acceptable = input.bridgeState === "succeeded"
    ? ["AWAITING_VERIFICATION", "DONE"]
    : [expectedWorkOrderState(input.bridgeState, "PENDING")];
  if (response.state && !acceptable.includes(String(response.state))) {
    ctx.warn(
      `[mc-adapter] state drift: bridge ${input.bridgeState} → MC ${String(response.state)} (expected ${acceptable.join("|")}) for work order ${ctx.workOrder._id}`,
    );
  }
}

function buildObjective(workOrder: McClaimableWorkOrder): string {
  const criteria = (workOrder.acceptanceCriteria ?? [])
    .map((criterion, index) => `${index + 1}. ${criterion.description ?? criterion.id}`);
  const lines = [
    `Mission Control work order: ${workOrder.title}`,
    "",
    "Desired outcome:",
    workOrder.desiredOutcome,
  ];
  if (workOrder.repository) lines.push("", `Repository: ${workOrder.repository}`);
  if (criteria.length > 0) lines.push("", "Acceptance criteria:", ...criteria);
  if (workOrder.constraints && Object.keys(workOrder.constraints).length > 0) {
    lines.push("", `Constraints: ${JSON.stringify(workOrder.constraints)}`);
  }
  return lines.join("\n");
}

function resolveWorkdir(workOrder: McClaimableWorkOrder): string {
  if (workOrder.repository && workOrder.repository.startsWith("/")) return workOrder.repository;
  return homedir();
}

function resolveTimeoutSeconds(workOrder: McClaimableWorkOrder, fallback = 3600): number {
  const raw = workOrder.constraints?.timeoutSeconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 86_400);
  return fallback;
}

function buildMissionOutputDir(workOrderId: string, bridgeRunId: string, agenticKbRoot?: string): string {
  const roots = resolveKnowledgeRoots(agenticKbRoot ? { agenticKbRoot } : {});
  const year = String(new Date().getFullYear());
  return join(roots.agenticKbRoot, "missions", year, `mission-mc-${workOrderId}`, "runs", `run-${bridgeRunId}`, "outputs");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
