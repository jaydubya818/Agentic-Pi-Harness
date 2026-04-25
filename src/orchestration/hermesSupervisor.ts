import { join, resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { digestPolicy, writeSessionStartProvenance } from "../session/provenance.js";
import { ContextPackBuilder, type ContextPackSource } from "../memory/contextPackBuilder.js";
import type { MemoryProvider } from "../memory/types.js";
import {
  runTaskViaBridge,
  type BridgeGovernedRun,
  type HermesAdapterOptions,
  type HermesAdapterSession,
  type HermesBridgeServerOptions,
  type HermesTaskAccepted,
  type HermesTaskResult,
} from "../hermes/index.js";

export interface RunHermesSupervisorInput {
  objective: string;
  workdir: string;
  outRoot: string;
  timeoutSeconds?: number;
  allowedTools?: string[];
  allowedActions?: string[];
  profile?: string;
  adapterOptions?: HermesAdapterOptions;
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeTimeoutMs?: number;
  bridgeOptions?: Partial<HermesBridgeServerOptions>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  missionId?: string;
  runId?: string;
  stepId?: string;
  useAgenticKbMemory?: boolean;
  memoryProvider?: MemoryProvider;
  memoryQuery?: string;
  memoryAgentId?: string;
  memoryProject?: string;
  memoryContextBudgetChars?: number;
}

export interface HermesExecutionContextReport {
  bridge_used: boolean;
  memory_used: boolean;
  agent_context_loaded: boolean;
  writeback_performed: boolean;
  fallback_reason?: string;
  sources: ContextPackSource[];
}

export interface HermesSupervisorRun {
  pi_session_id: string;
  adapter_session: HermesAdapterSession;
  accepted: HermesTaskAccepted;
  result: HermesTaskResult;
  session_dir: string;
  request_path: string;
  result_path: string;
  event_log_path: string;
  artifact_dir: string;
  bridge_url?: string;
  bridge_mode: "embedded" | "external";
  bridge_fallback_reason?: string;
  context_report: HermesExecutionContextReport;
}

export { type MemoryProvider };

export async function runHermesSupervisorTask(input: RunHermesSupervisorInput): Promise<HermesSupervisorRun> {
  const logger = input.logger ?? new NoopLogger();
  const outRoot = resolve(input.outRoot);
  const policyDigest = digestPolicy({
    supervisor: "hermes",
    allowedTools: input.allowedTools ?? ["bash", "git", "python"],
    allowedActions: input.allowedActions ?? ["read", "write", "patch", "test"],
  });

  let objective = input.objective;
  let contextReport: HermesExecutionContextReport = {
    bridge_used: true,
    memory_used: false,
    agent_context_loaded: false,
    writeback_performed: false,
    sources: [],
  };

  if (input.useAgenticKbMemory) {
    if (!input.memoryProvider) {
      contextReport = {
        ...contextReport,
        fallback_reason: "memory provider not configured",
      };
    } else {
      const health = await input.memoryProvider.healthCheck();
      if (!health.enabled || !health.ok) {
        contextReport = {
          ...contextReport,
          fallback_reason: health.reason ?? "memory provider unavailable",
        };
      } else {
        const searchResults = await input.memoryProvider.search(input.memoryQuery ?? input.objective, { limit: 5 });
        const agentContext = input.memoryAgentId
          ? await input.memoryProvider.loadAgentContext(input.memoryAgentId, { project: input.memoryProject })
          : null;
        const pack = new ContextPackBuilder().build({
          task: input.objective,
          maxChars: input.memoryContextBudgetChars ?? 6000,
          memoryResults: searchResults,
          agentContext,
        });
        objective = pack.taskPrompt;
        contextReport = {
          ...contextReport,
          memory_used: pack.memoryUsed,
          agent_context_loaded: pack.agentContextLoaded,
          sources: pack.sources,
        };
      }
    }
  }

  logger.log("info", "hermes.supervisor.bridge_routed", {
    bridgeUrl: input.bridgeUrl ?? "embedded",
  });

  const result: BridgeGovernedRun = await runTaskViaBridge({
    objective,
    workdir: input.workdir,
    outRoot,
    timeoutSeconds: input.timeoutSeconds,
    allowedTools: input.allowedTools,
    allowedActions: input.allowedActions,
    profile: input.profile,
    env: input.env,
    logger,
    missionId: input.missionId,
    runId: input.runId,
    stepId: input.stepId,
    bridgeUrl: input.bridgeUrl,
    bridgeToken: input.bridgeToken,
    bridgeTimeoutMs: input.bridgeTimeoutMs,
    bridgeOptions: input.bridgeOptions,
    adapterOptions: input.adapterOptions,
  });

  await writeSessionStartProvenance(join(result.session_dir, "provenance.json"), {
    sessionId: result.pi_session_id,
    loopGitSha: "dev",
    repoGitSha: null,
    provider: "hermes-bridge",
    model: "hermes-agent",
    costTableVersion: "n/a",
    piMdDigest: null,
    policyDigest,
  });

  return {
    ...result,
    context_report: {
      ...contextReport,
      fallback_reason: result.bridge_fallback_reason ?? contextReport.fallback_reason,
    },
  };
}
