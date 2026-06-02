import type { AgenticKbAccessMode } from "../memory/types.js";

export interface PiRuntimeConfig {
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeTimeoutMs: number;
  agenticKbPath?: string;
  agenticKbAccessMode: AgenticKbAccessMode;
  agenticKbMaxResults: number;
  agenticKbContextBudgetChars: number;
  kbApiUrl?: string;
  privatePin?: string;
  anthropicApiKey?: string;
}

export function readPiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PiRuntimeConfig {
  return {
    bridgeUrl: env.PI_HERMES_BRIDGE_URL?.trim() || undefined,
    bridgeToken: env.PI_HERMES_BRIDGE_TOKEN?.trim() || undefined,
    bridgeTimeoutMs: parseNumber(env.PI_HERMES_BRIDGE_TIMEOUT_MS, 30_000),
    agenticKbPath: env.PI_AGENTIC_KB_PATH?.trim() || undefined,
    agenticKbAccessMode: parseAccessMode(env.PI_AGENTIC_KB_ACCESS_MODE),
    agenticKbMaxResults: parseNumber(env.PI_AGENTIC_KB_MAX_RESULTS, 5),
    agenticKbContextBudgetChars: parseNumber(env.PI_AGENTIC_KB_CONTEXT_BUDGET_CHARS, 6_000),
    kbApiUrl: env.KB_API_URL?.trim() || undefined,
    privatePin: env.PRIVATE_PIN?.trim() || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAccessMode(raw: string | undefined): AgenticKbAccessMode {
  if (raw === "local" || raw === "http" || raw === "disabled" || raw === "auto") return raw;
  return "auto";
}
