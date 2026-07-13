import { z } from "zod";

/** Raised when MC adapter env configuration is invalid. */
export class McConfigError extends Error {}

const BoolFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === "") return undefined;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  });

const IntFromEnv = (fallback: number): z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined> =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") return fallback;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new McConfigError(`expected positive integer, got: ${value}`);
      }
      return parsed;
    });

const McEnvSchema = z.object({
  MC_EXECUTOR_ENABLED: BoolFromEnv,
  MC_CONVEX_URL: z.string().optional(),
  MC_CLAIM_POLL_ENABLED: BoolFromEnv,
  MC_SUPERVISOR_AGENT_NAME: z.string().optional(),
  MC_WORKER_AGENT_NAME: z.string().optional(),
  MC_HEARTBEAT_INTERVAL_MS: IntFromEnv(30_000),
  MC_CLAIM_POLL_INTERVAL_MS: IntFromEnv(15_000),
  MC_SESSION_LOG_EXCERPT_MAX_BYTES: IntFromEnv(4096),
});

export interface McConfig {
  convexUrl: string;
  claimPollEnabled: boolean;
  supervisorAgentName: string;
  workerAgentName: string;
  heartbeatIntervalMs: number;
  claimPollIntervalMs: number;
  sessionLogExcerptMaxBytes: number;
}

/**
 * Parse MC adapter configuration from the environment.
 * Returns null when MC_EXECUTOR_ENABLED is unset/false (master switch, default off).
 * Throws McConfigError when enabled without MC_CONVEX_URL.
 */
export function loadMcConfig(env: NodeJS.ProcessEnv = process.env): McConfig | null {
  const parsed = McEnvSchema.parse({
    MC_EXECUTOR_ENABLED: env.MC_EXECUTOR_ENABLED,
    MC_CONVEX_URL: env.MC_CONVEX_URL,
    MC_CLAIM_POLL_ENABLED: env.MC_CLAIM_POLL_ENABLED,
    MC_SUPERVISOR_AGENT_NAME: env.MC_SUPERVISOR_AGENT_NAME,
    MC_WORKER_AGENT_NAME: env.MC_WORKER_AGENT_NAME,
    MC_HEARTBEAT_INTERVAL_MS: env.MC_HEARTBEAT_INTERVAL_MS,
    MC_CLAIM_POLL_INTERVAL_MS: env.MC_CLAIM_POLL_INTERVAL_MS,
    MC_SESSION_LOG_EXCERPT_MAX_BYTES: env.MC_SESSION_LOG_EXCERPT_MAX_BYTES,
  });

  if (parsed.MC_EXECUTOR_ENABLED !== true) return null;

  const convexUrl = parsed.MC_CONVEX_URL?.trim();
  if (!convexUrl) {
    throw new McConfigError("MC_CONVEX_URL is required when MC_EXECUTOR_ENABLED is set");
  }

  return {
    convexUrl,
    claimPollEnabled: parsed.MC_CLAIM_POLL_ENABLED === true,
    supervisorAgentName: parsed.MC_SUPERVISOR_AGENT_NAME?.trim() || "pi-supervisor",
    workerAgentName: parsed.MC_WORKER_AGENT_NAME?.trim() || "hermes-executor",
    heartbeatIntervalMs: parsed.MC_HEARTBEAT_INTERVAL_MS,
    claimPollIntervalMs: parsed.MC_CLAIM_POLL_INTERVAL_MS,
    sessionLogExcerptMaxBytes: parsed.MC_SESSION_LOG_EXCERPT_MAX_BYTES,
  };
}
