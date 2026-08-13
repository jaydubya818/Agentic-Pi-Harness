import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { digestPolicy, safeWriteJson, writeSessionStartProvenance } from "../session/provenance.js";
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

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "interrupted"];

const pollSettings = {
  /** Slack past the task timeout before the poll loop gives up on the run. */
  deadlineGraceMs: 5000,
  /** How long to wait for the deadline-expiry cancel to settle the run. */
  cancelSettleMs: 5000,
};

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
  let adapterSession: HermesAdapterSession | null = null;

  try {
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ workdir, env: input.env, profile: input.profile }),
    });
    if (!sessionResponse.ok) {
      throw new Error(`bridge session create failed: HTTP ${sessionResponse.status} ${await sessionResponse.text()}`);
    }
    adapterSession = await sessionResponse.json() as HermesAdapterSession;

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
    // request.json is the immutable record of what was asked; write it with
    // the same write-rename+fsync treatment as every other persisted record.
    await safeWriteJson(requestPath, request);

    const executeResponse = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    // Read as text first: a non-JSON error body (auth rejection, proxy HTML
    // page) must surface the HTTP status, not an opaque JSON parse error.
    const executeBody = await executeResponse.text();
    if (executeResponse.status !== 202) {
      throw new Error(`bridge execute failed: HTTP ${executeResponse.status} ${executeBody.slice(0, 500)}`);
    }
    let accepted: HermesTaskAccepted;
    try {
      accepted = JSON.parse(executeBody) as HermesTaskAccepted;
    } catch {
      throw new Error(`bridge execute returned a non-JSON 202 body: ${executeBody.slice(0, 500)}`);
    }

    let run: any = null;
    let pollDelayMs = 50;
    const deadline = Date.now() + ((input.timeoutSeconds ?? 900) * 1000) + pollSettings.deadlineGraceMs;
    while (Date.now() < deadline) {
      try {
        const runResponse = await fetch(`${baseUrl}/runs/${accepted.execution_id}`, { headers: authHeaders });
        if (runResponse.ok) {
          run = await runResponse.json();
          const terminal = TERMINAL_RUN_STATUSES.includes(run.status);
          if (terminal && (run.worker_result || run.result)) break;
          // A terminal run that reports an error but no result payload will
          // never grow one (spawn failure, torn transport, bridge restart
          // reconciliation); polling until the deadline would hang the
          // caller for the full task timeout before failing anyway.
          if (terminal && run.error) break;
        }
      } catch {
        // A single flaky poll (connection reset, non-JSON error body) must
        // not abort a governed run that is still executing; keep polling.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollDelayMs));
      // Fast first polls keep short embedded runs snappy; back off to 500ms
      // so long-running governed work is not hammered with ~20 req/s.
      pollDelayMs = Math.min(pollDelayMs * 2, 500);
    }

    if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) {
      // The poll deadline expired with the run still executing. Best-effort
      // cancel so an external long-lived bridge does not keep running a
      // governed task nobody is waiting on anymore (the embedded bridge is
      // cancelled by server.stop() in the finally block either way).
      try {
        await fetch(`${baseUrl}/cancel`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ execution_id: accepted.execution_id }),
        });
      } catch {
        // cancel is cleanup; the missing-result error below is authoritative
      }
      // /cancel answers 202 before the run actually settles. Without a
      // bounded wait for the terminal record, the session close in the
      // finally block races the still-settling run and answers 409, leaking
      // the adapter session on an external long-lived bridge -- and the
      // error below reports a stale "running" status. If the run settles
      // with a result payload, return it like any other terminal run.
      const settleDeadline = Date.now() + pollSettings.cancelSettleMs;
      while (Date.now() < settleDeadline) {
        try {
          const runResponse = await fetch(`${baseUrl}/runs/${accepted.execution_id}`, { headers: authHeaders });
          if (runResponse.ok) {
            const latest: any = await runResponse.json();
            if (TERMINAL_RUN_STATUSES.includes(latest.status)) {
              run = latest;
              break;
            }
          }
        } catch {
          // keep waiting; the settle window is bounded either way
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }

    try {
      const eventsResponse = await fetch(`${baseUrl}/runs/${accepted.execution_id}/events?view=raw`, { headers: authHeaders });
      const events = eventsResponse.ok ? await eventsResponse.json() as Array<Record<string, unknown>> : [];
      if (Array.isArray(events) && events.length > 0) await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    } catch {
      // Event capture is best-effort; result.json is the source of truth.
    }

    const result = (run?.worker_result ?? run?.result) as HermesTaskResult | null;
    if (!result) {
      const status = run?.status ?? "unknown";
      const suffix = run?.error ? `: ${run.error}` : "";
      throw new Error(`bridge run did not produce a result for execution ${accepted.execution_id} (status ${status}${suffix})`);
    }
    // result.json is the source of truth for the governed run; a crash here
    // must leave either no file or a complete one, never torn JSON.
    await safeWriteJson(resultPath, result);

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
    // Release the bridge-side session so a long-lived bridge does not
    // accumulate one idle adapter session per governed run. Best-effort:
    // a still-running execution (409) or an unreachable bridge must not
    // mask the run's real outcome.
    if (adapterSession) {
      try {
        await fetch(`${baseUrl}/sessions/${adapterSession.session_id}/close`, { method: "POST", headers: authHeaders });
      } catch {
        // ignore — session close is cleanup, not part of the run contract
      }
    }
    if (server) await server.stop();
  }
}

export const __bridgeClientTestables = { pollSettings };
