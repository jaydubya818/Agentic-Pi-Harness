import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWriteJson } from "../session/provenance.js";
import type { McClient } from "./client.js";
import type { McConfig } from "./config.js";

/** Raised when Mission Control registration does not return an agent id. */
export class McIdentityError extends Error {}

export interface McIdentity {
  supervisorId: string;
  workerId: string;
  supervisorName: string;
  workerName: string;
}

export function defaultMcStateDir(): string {
  return join(homedir(), ".pi", "hermes-bridge-state");
}

export function mcIdentityPath(stateDir: string = defaultMcStateDir()): string {
  return join(stateDir, "mc-identity.json");
}

/** Pi harness repo root (src/mc/… or dist/mc/… → two levels up). */
function piRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Register (or refresh) both executor identities with Mission Control and
 * persist the resulting agent ids next to the bridge state (same safe-write
 * pattern as bridgeState). Registration is idempotent on the MC side —
 * existing agents by name are updated, not duplicated.
 */
export async function ensureIdentities(
  client: Pick<McClient, "registerAgent">,
  config: McConfig,
  stateDir: string = defaultMcStateDir(),
): Promise<McIdentity> {
  const supervisor = await client.registerAgent({
    name: config.supervisorAgentName,
    role: "LEAD",
    workspacePath: piRepoRoot(),
    allowedTaskTypes: ["OPS"],
  });
  const worker = await client.registerAgent({
    name: config.workerAgentName,
    role: "SPECIALIST",
    workspacePath: join(homedir(), ".hermes", "hermes-agent"),
    allowedTaskTypes: ["ENGINEERING"],
  });

  if (!supervisor.agent?._id || !worker.agent?._id) {
    throw new McIdentityError("Mission Control registration did not return agent ids");
  }

  const identity: McIdentity = {
    supervisorId: supervisor.agent._id,
    workerId: worker.agent._id,
    supervisorName: config.supervisorAgentName,
    workerName: config.workerAgentName,
  };
  await safeWriteJson(mcIdentityPath(stateDir), identity);
  return identity;
}

/** Load a previously persisted identity, or null when absent/invalid. */
export async function loadPersistedIdentity(stateDir: string = defaultMcStateDir()): Promise<McIdentity | null> {
  try {
    const raw = JSON.parse(await readFile(mcIdentityPath(stateDir), "utf8")) as Partial<McIdentity>;
    if (raw.supervisorId && raw.workerId && raw.supervisorName && raw.workerName) {
      return raw as McIdentity;
    }
    return null;
  } catch {
    return null;
  }
}
