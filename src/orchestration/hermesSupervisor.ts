import { join, resolve } from "node:path";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { digestPolicy, writeSessionStartProvenance } from "../session/provenance.js";
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
  bridgeOptions?: Partial<HermesBridgeServerOptions>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  missionId?: string;
  runId?: string;
  stepId?: string;
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
}

export async function runHermesSupervisorTask(input: RunHermesSupervisorInput): Promise<HermesSupervisorRun> {
  const logger = input.logger ?? new NoopLogger();
  const outRoot = resolve(input.outRoot);
  const policyDigest = digestPolicy({
    supervisor: "hermes",
    allowedTools: input.allowedTools ?? ["bash", "git", "python"],
    allowedActions: input.allowedActions ?? ["read", "write", "patch", "test"],
  });

  logger.log("info", "hermes.supervisor.bridge_routed", {
    bridgeUrl: input.bridgeUrl ?? "embedded",
  });

  const result: BridgeGovernedRun = await runTaskViaBridge({
    objective: input.objective,
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

  return result;
}
