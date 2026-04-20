import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { digestPolicy, writeSessionStartProvenance } from "../session/provenance.js";
import { HermesBridgeServer, type HermesBridgeServerOptions } from "./httpBridge.js";
import type { HermesAdapterOptions, HermesAdapterSession, HermesTaskAccepted, HermesTaskResult } from "./index.js";

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
  bridgeOptions?: Partial<HermesBridgeServerOptions>;
  adapterOptions?: HermesAdapterOptions;
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

  const embedded = !input.bridgeUrl;
  const server = embedded ? new HermesBridgeServer({
    host: "127.0.0.1",
    port: 0,
    enforceKnowledgePolicy: false,
    adapterOptions: input.adapterOptions,
    ...(input.bridgeOptions ?? {}),
  }) : null;
  const listening = server ? await server.start() : null;
  const baseUrl = input.bridgeUrl ?? `http://${listening!.host}:${listening!.port}`;
  const authHeaders: Record<string, string> = input.bridgeToken ? { Authorization: `Bearer ${input.bridgeToken}` } : {};

  try {
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ workdir, env: input.env, profile: input.profile }),
    });
    const adapterSession = await sessionResponse.json() as HermesAdapterSession;

    const request = {
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

    const executeResponse = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const accepted = await executeResponse.json() as HermesTaskAccepted;
    if (executeResponse.status !== 202) throw new Error(`bridge execute failed: ${JSON.stringify(accepted)}`);

    let run: any = null;
    const deadline = Date.now() + ((input.timeoutSeconds ?? 900) * 1000) + 5000;
    while (Date.now() < deadline) {
      const runResponse = await fetch(`${baseUrl}/runs/${accepted.execution_id}`, { headers: authHeaders });
      run = await runResponse.json();
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
      if (terminal && (run.worker_result || run.result)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }

    const eventsResponse = await fetch(`${baseUrl}/runs/${accepted.execution_id}/events?view=raw`, { headers: authHeaders });
    const events = await eventsResponse.json() as Array<Record<string, unknown>>;
    if (events.length > 0) await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

    const result = (run?.worker_result ?? run?.result) as HermesTaskResult | null;
    if (!result) throw new Error(`bridge run did not produce a result for execution ${accepted.execution_id}`);
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");

    logger.child({ piSessionId, hermesSessionId: adapterSession.session_id, executionId: accepted.execution_id }).log("info", "hermes.supervisor.bridge.completed", {
      status: result?.status,
      artifactDir,
      bridgeUrl: baseUrl,
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
    };
  } finally {
    if (server) await server.stop();
  }
}
