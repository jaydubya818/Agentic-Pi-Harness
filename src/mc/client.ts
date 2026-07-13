import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { McBridgeExecutionState, McVerificationStatus, McWorkOrderState } from "./stateMap.js";

/** Raised when a Mission Control call fails after retry. */
export class McClientError extends Error {}

/**
 * Minimal transport seam over ConvexHttpClient so tests can inject a mock
 * (no network in tests). Function names use Convex "module:function" paths.
 */
export interface McConvexTransport {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function createConvexTransport(convexUrl: string): McConvexTransport {
  const client = new ConvexHttpClient(convexUrl);
  return {
    query: (name, args) => client.query(makeFunctionReference<"query">(name), args),
    mutation: (name, args) => client.mutation(makeFunctionReference<"mutation">(name), args),
  };
}

// ── Result shapes (mirror of MC branch sf/21a-executor-contract) ────────────

export interface McRegisteredAgent {
  _id: string;
  name: string;
  role: string;
  status: string;
  [key: string]: unknown;
}

export interface McRegisterResult {
  agent: McRegisteredAgent | null;
  created: boolean;
}

export interface McHeartbeatResult {
  success: boolean;
  budgetRemaining?: number;
  budgetExceeded?: boolean;
  pendingTasks?: unknown[];
  claimableTasks?: unknown[];
  pendingApprovals?: unknown[];
  pendingNotifications?: unknown[];
  error?: string;
}

export interface McClaimableWorkOrder {
  _id: string;
  title: string;
  desiredOutcome: string;
  repository?: string;
  riskLevel: string;
  priority: string;
  state: string;
  acceptanceCriteria: Array<{ id: string; description?: string; status?: string }>;
  constraints?: Record<string, unknown>;
  claimAttempt: number;
}

export interface McClaimResult {
  claimed: boolean;
  replay?: boolean;
  attempt?: number;
  reason?: string;
  state?: McWorkOrderState | string;
}

export interface McReportResult {
  applied: boolean;
  replay: boolean;
  state?: McWorkOrderState | string;
}

export interface McVerificationResult extends McReportResult {
  verificationStatus?: McVerificationStatus;
}

export interface McArtifactResult {
  recorded: boolean;
  replay: boolean;
  contentDropId: string;
}

export interface McSessionLogRef {
  kind: "HERMES_SESSION" | "PI_TAPE" | "BRIDGE_EVENTS";
  path: string;
  sha256: string;
  sizeBytes: number;
  excerpt?: string;
}

export type McRunCompletionStatus = "COMPLETED" | "FAILED" | "TIMEOUT";

interface McClientLogger {
  warn(message: string): void;
}

const RETRYABLE_PATTERN = /fetch failed|network|socket|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|abort/i;

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    // Convex function-thrown errors carry structured data — never retry those.
    if ("data" in error) return false;
    return error instanceof TypeError || RETRYABLE_PATTERN.test(error.message);
  }
  return false;
}

/** Strip anything URL-shaped so the Convex deployment URL never reaches logs. */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]");
}

/**
 * Thin typed wrapper over the Mission Control Convex functions used by the
 * Pi bridge executor adapter. One retry with backoff on network errors only;
 * function-thrown errors surface immediately. Never logs the Convex URL.
 */
export class McClient {
  private readonly transport: McConvexTransport;
  private readonly logger: McClientLogger;
  private readonly retryBackoffMs: number;

  constructor(transport: McConvexTransport, options: { logger?: McClientLogger; retryBackoffMs?: number } = {}) {
    this.transport = transport;
    this.logger = options.logger ?? console;
    this.retryBackoffMs = options.retryBackoffMs ?? 500;
  }

  async registerAgent(args: {
    name: string;
    role: string;
    workspacePath: string;
    allowedTaskTypes?: string[];
  }): Promise<McRegisterResult> {
    return await this.call("mutation", "agents:register", args) as McRegisterResult;
  }

  async heartbeat(args: {
    agentId: string;
    currentTaskId?: string;
    spendSinceLastHeartbeat?: number;
    status?: string;
    errorMessage?: string;
  }): Promise<McHeartbeatResult> {
    return await this.call("mutation", "agents:heartbeat", args) as McHeartbeatResult;
  }

  async listClaimable(limit?: number): Promise<McClaimableWorkOrder[]> {
    const args: Record<string, unknown> = limit === undefined ? {} : { limit };
    return await this.call("query", "workOrdersExecutor:listClaimable", args) as McClaimableWorkOrder[];
  }

  async claimForExecutor(args: {
    workOrderId: string;
    agentId: string;
    executionId: string;
    idempotencyKey: string;
    leaseMs?: number;
  }): Promise<McClaimResult> {
    return await this.call("mutation", "workOrdersExecutor:claimForExecutor", args) as McClaimResult;
  }

  async reportExecutionEvent(args: {
    workOrderId: string;
    agentId: string;
    bridgeState: McBridgeExecutionState;
    seq: number;
    bridgeRunId: string;
    idempotencyKey: string;
    summary?: string;
    hermesSessionId?: string;
    runId?: string;
    pullRequestId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<McReportResult> {
    return await this.call("mutation", "workOrdersExecutor:reportExecutionEvent", args) as McReportResult;
  }

  async recordVerificationEvidence(args: {
    workOrderId: string;
    agentId: string;
    criterionId: string;
    status: McVerificationStatus;
    evidence: string;
    idempotencyKey: string;
  }): Promise<McVerificationResult> {
    return await this.call("mutation", "workOrdersExecutor:recordVerificationEvidence", args) as McVerificationResult;
  }

  async recordExecutorArtifact(args: {
    workOrderId: string;
    agentId: string;
    artifactId: string;
    title: string;
    content: string;
    sha256: string;
    contentType?: string;
    idempotencyKey: string;
  }): Promise<McArtifactResult> {
    return await this.call("mutation", "workOrdersExecutor:recordExecutorArtifact", args) as McArtifactResult;
  }

  /** runs:start — returns the Mission Control run id. */
  async startRun(args: {
    agentId: string;
    sessionKey: string;
    model: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const result = await this.call("mutation", "runs:start", args) as { run: { _id: string } };
    return result.run._id;
  }

  async completeRun(args: {
    runId: string;
    status: McRunCompletionStatus;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    sessionLogRefs?: McSessionLogRef[];
    error?: string;
  }): Promise<void> {
    // MC's runs:complete validator requires token/cost numbers; unknown → 0.
    await this.call("mutation", "runs:complete", {
      runId: args.runId,
      status: args.status,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      costUsd: args.costUsd ?? 0,
      ...(args.sessionLogRefs ? { sessionLogRefs: args.sessionLogRefs } : {}),
      ...(args.error ? { error: args.error } : {}),
    });
  }

  private async call(
    kind: "query" | "mutation",
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.dispatch(kind, name, args);
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      this.logger.warn(`[mc-adapter] ${name} network error, retrying once: ${sanitizeErrorMessage(error)}`);
      await delay(this.retryBackoffMs);
      try {
        return await this.dispatch(kind, name, args);
      } catch (retryError) {
        throw new McClientError(`${name} failed after retry: ${sanitizeErrorMessage(retryError)}`);
      }
    }
  }

  private async dispatch(kind: "query" | "mutation", name: string, args: Record<string, unknown>): Promise<unknown> {
    return kind === "query" ? this.transport.query(name, args) : this.transport.mutation(name, args);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
