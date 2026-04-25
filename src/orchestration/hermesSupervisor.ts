import { resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { appendMemoryContextToObjective, type MemoryContextPack, type MemoryProvider } from "../memory/index.js";
import type { ContextPackSource } from "../memory/contextPackBuilder.js";
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
        const pack = await input.memoryProvider.buildContextPack({
          query: input.memoryQuery ?? input.objective,
          agentId: input.memoryAgentId,
          project: input.memoryProject,
          budgetChars: input.memoryContextBudgetChars ?? 6000,
        });
        objective = appendMemoryContextToObjective(input.objective, pack);
        contextReport = {
          ...contextReport,
          memory_used: pack.used,
          agent_context_loaded: pack.items.some((item) => item.kind === "agent-context"),
          sources: mapContextSources(pack),
          fallback_reason: pack.used || pack.available ? contextReport.fallback_reason : firstWarning(pack),
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

  return {
    ...result,
    context_report: {
      ...contextReport,
      fallback_reason: result.bridge_fallback_reason ?? contextReport.fallback_reason,
    },
  };
}

function mapContextSources(pack: MemoryContextPack): ContextPackSource[] {
  return pack.items.map((item) => ({
    kind: item.kind === "search" ? "memory" : "agent_context",
    title: item.title,
    path: item.path ?? item.slug ?? item.title,
    slug: item.slug,
  }));
}

function firstWarning(pack: MemoryContextPack): string | undefined {
  return pack.warnings[0];
}
