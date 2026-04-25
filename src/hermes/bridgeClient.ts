import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { digestPolicy, writeSessionStartProvenance } from "../session/provenance.js";
import type { HermesAdapterOptions, HermesAdapterSession } from "./adapter.js";
import type { HermesTaskAccepted, HermesTaskRequest, HermesTaskResult } from "./contracts.js";
import { HermesBridgeServer, type HermesBridgeServerOptions } from "./httpBridge.js";

export interface BridgeExecuteTaskInput {
  objective: string;
  workdir: string;
  outRoot: string;
  timeoutSeconds?: number;
  allowedTools?: string[];
  allowedActions?: string[];
  profile?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  missionId?: string;
  runId?: string;
  stepId?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeTimeoutMs?: number;
  bridgeOptions?: Partial<HermesBridgeServerOptions>;
  adapterOptions?: HermesAdapterOptions;
}

export interface HermesBridgeRunView {
  execution_id: string;
  request_id: string;
  session_id: string;
  status: string;
  run_kind?: string;
  lifecycle?: {
    bridge_status?: string;
    state?: string;
    terminal?: boolean;
    failure_class?: string | null;
  };
  result?: HermesTaskResult | null;
  worker_result?: HermesTaskResult | null;
  error?: string | null;
}

export interface HermesBridgeEventsView {
  event_format: string;
  items: Array<{ type: string; data?: Record<string, unknown> }>;
}

export interface HermesBridgeHealth {
  ok: boolean;
  baseUrl: string;
  status?: number;
  reason?: string;
  authRequired?: boolean;
  binaryPath?: string | null;
  repoPath?: string | null;
}

export interface HermesBridgeClientOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WaitForTerminalRunOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class HermesBridgeClient {
  private readonly baseUrl: string;
  private readonly authToken: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesBridgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authToken = options.authToken ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async healthCheck(): Promise<HermesBridgeHealth> {
    try {
      const healthResponse = await this.request("/healthz", { method: "GET" }, false);
      if (!healthResponse.ok) {
        return {
          ok: false,
          baseUrl: this.baseUrl,
          status: healthResponse.status,
          reason: `healthz returned ${healthResponse.status}`,
        };
      }

      const metaResponse = await this.request("/meta", { method: "GET" }, true);
      if (!metaResponse.ok) {
        return {
          ok: true,
          baseUrl: this.baseUrl,
          status: healthResponse.status,
          reason: `meta returned ${metaResponse.status}`,
        };
      }
      const meta = await metaResponse.json() as { authRequired?: boolean; binaryPath?: string | null; repoPath?: string | null };
      return {
        ok: true,
        baseUrl: this.baseUrl,
        status: healthResponse.status,
        authRequired: meta.authRequired,
        binaryPath: meta.binaryPath ?? null,
        repoPath: meta.repoPath ?? null,
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createSession(body: { workdir: string; env?: NodeJS.ProcessEnv; profile?: string }): Promise<HermesAdapterSession> {
    const response = await this.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await this.expectJson<HermesAdapterSession>(response, "create session");
  }

  async executeTask(request: HermesTaskRequest): Promise<HermesTaskAccepted> {
    const response = await this.request("/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return await this.expectJson<HermesTaskAccepted>(response, "execute task");
  }

  async getRun(executionId: string): Promise<HermesBridgeRunView> {
    const response = await this.request(`/runs/${executionId}`, { method: "GET" });
    return await this.expectJson<HermesBridgeRunView>(response, "get run");
  }

  async getEvents(executionId: string, raw = false): Promise<HermesBridgeEventsView> {
    const suffix = raw ? "?view=raw" : "";
    const response = await this.request(`/runs/${executionId}/events${suffix}`, { method: "GET" });
    const payload = await this.expectJson<HermesBridgeEventsView | Array<{ type: string; data?: Record<string, unknown> }>>(response, "get events");
    if (Array.isArray(payload)) {
      return {
        event_format: raw ? "raw" : "legacy",
        items: payload,
      };
    }
    return payload;
  }

  async waitForTerminalRun(executionId: string, options: WaitForTerminalRunOptions = {}): Promise<HermesBridgeRunView> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastRun: HermesBridgeRunView | null = null;
    while (Date.now() < deadline) {
      const run = await this.getRun(executionId);
      lastRun = run;
      if (isTerminalStatus(run.status) && (run.worker_result || run.result || run.error)) return run;
      await sleep(pollIntervalMs);
    }
    throw new Error(`bridge wait timed out after ${timeoutMs}ms for execution ${executionId}; last status=${lastRun?.status ?? "unknown"}`);
  }

  private async request(path: string, init: RequestInit, requireAuth = true): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error(`bridge timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      const headers = new Headers(init.headers ?? undefined);
      if (requireAuth && this.authToken) headers.set("authorization", `Bearer ${this.authToken}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async expectJson<T>(response: Response, action: string): Promise<T> {
    const payload = await response.json() as T | { error?: string };
    if (!response.ok) {
      const message = typeof payload === "object" && payload && "error" in payload ? (payload.error ?? response.statusText) : response.statusText;
      throw new Error(`${action} failed: ${message}`);
    }
    return payload as T;
  }
}

export interface BridgeGovernedRun {
  pi_session_id: string;
  adapter_session: HermesAdapterSession;
  accepted: HermesTaskAccepted;
  result: HermesTaskResult;
  session_dir: string;
  request_path: string;
  result_path: string;
  event_log_path: string;
  artifact_dir: string;
  bridge_url: string;
  bridge_mode: "embedded" | "external";
  bridge_fallback_reason?: string;
}

export async function runTaskViaBridge(input: BridgeExecuteTaskInput): Promise<BridgeGovernedRun> {
  const logger = input.logger ?? new NoopLogger();
  const outRoot = resolve(input.outRoot);
  const workdir = resolve(input.workdir);
  const piSessionId = `hermes-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const sessionDir = join(outRoot, "sessions", piSessionId);
  const artifactDir = join(sessionDir, "artifacts", "req-1");
  const requestPath = join(sessionDir, "request.json");
  const resultPath = join(sessionDir, "result.json");
  const eventLogPath = join(sessionDir, "events.jsonl");
  const missionId = input.missionId ?? `mission_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const runId = input.runId ?? `run_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const stepId = input.stepId ?? `step_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  await mkdir(artifactDir, { recursive: true });
  const policyDigest = digestPolicy({
    supervisor: "hermes",
    allowedTools: input.allowedTools ?? ["bash", "git", "python"],
    allowedActions: input.allowedActions ?? ["read", "write", "patch", "test"],
  });
  await writeSessionStartProvenance(join(sessionDir, "provenance.json"), {
    sessionId: piSessionId,
    loopGitSha: "dev",
    repoGitSha: null,
    provider: "hermes-bridge",
    model: "hermes-agent",
    costTableVersion: "n/a",
    piMdDigest: null,
    policyDigest,
  });

  let server: HermesBridgeServer | null = null;
  let bridgeMode: "embedded" | "external" = "external";
  let bridgeFallbackReason: string | undefined;
  let baseUrl = input.bridgeUrl ?? "";

  if (!input.bridgeUrl) {
    server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      enforceKnowledgePolicy: false,
      adapterOptions: input.adapterOptions,
      ...(input.bridgeOptions ?? {}),
    });
    const listening = await server.start();
    baseUrl = `http://${listening.host}:${listening.port}`;
    bridgeMode = "embedded";
  } else {
    const externalClient = new HermesBridgeClient({
      baseUrl: input.bridgeUrl,
      authToken: input.bridgeToken,
      timeoutMs: input.bridgeTimeoutMs,
    });
    const health = await externalClient.healthCheck();
    if (!health.ok) {
      server = new HermesBridgeServer({
        host: "127.0.0.1",
        port: 0,
        enforceKnowledgePolicy: false,
        adapterOptions: input.adapterOptions,
        ...(input.bridgeOptions ?? {}),
      });
      const listening = await server.start();
      baseUrl = `http://${listening.host}:${listening.port}`;
      bridgeMode = "embedded";
      bridgeFallbackReason = `external bridge unavailable: ${health.reason ?? "health check failed"}`;
    }
  }

  const client = new HermesBridgeClient({
    baseUrl,
    authToken: input.bridgeToken,
    timeoutMs: bridgeMode === "embedded" ? Math.max(input.bridgeTimeoutMs ?? 30_000, 5_000) : input.bridgeTimeoutMs,
  });

  try {
    const adapterSession = await client.createSession({ workdir, env: input.env, profile: input.profile });
    const request: HermesTaskRequest = {
      request_id: "req_1",
      session_id: adapterSession.session_id,
      objective: input.objective,
      workdir,
      allowed_tools: input.allowedTools ?? ["bash", "git", "python"],
      allowed_actions: input.allowedActions ?? ["read", "write", "patch", "test"],
      timeout_seconds: input.timeoutSeconds ?? 900,
      output_dir: artifactDir,
      metadata: {
        mission_id: missionId,
        run_id: runId,
        step_id: stepId,
      },
    };
    await writeFile(requestPath, JSON.stringify(request, null, 2) + "\n", "utf8");

    const accepted = await client.executeTask(request);
    const run = await client.waitForTerminalRun(accepted.execution_id, {
      timeoutMs: ((input.timeoutSeconds ?? 900) * 1000) + 5000,
      pollIntervalMs: 50,
    });
    const events = await client.getEvents(accepted.execution_id, true);
    if (events.items.length > 0) {
      await writeFile(eventLogPath, events.items.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    }

    const result = run.worker_result ?? run.result;
    if (!result) throw new Error(`bridge run did not produce a result for execution ${accepted.execution_id}`);
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");

    logger.child({ piSessionId, hermesSessionId: adapterSession.session_id, executionId: accepted.execution_id }).log("info", "hermes.supervisor.bridge.completed", {
      status: result.status,
      artifactDir,
      bridgeUrl: baseUrl,
      bridgeMode,
    });

    return {
      pi_session_id: piSessionId,
      adapter_session: adapterSession,
      accepted,
      result,
      session_dir: sessionDir,
      request_path: requestPath,
      result_path: resultPath,
      event_log_path: eventLogPath,
      artifact_dir: artifactDir,
      bridge_url: baseUrl,
      bridge_mode: bridgeMode,
      bridge_fallback_reason: bridgeFallbackReason,
    };
  } finally {
    if (server) await server.stop();
  }
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
