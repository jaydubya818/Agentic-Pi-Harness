import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HermesDiscovery {
  binaryPath: string | null;
  repoPath: string | null;
}

export function detectHermesBinaryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.HERMES_COMMAND ?? env.HERMES_BINARY_PATH;
  if (explicit && isExecutable(explicit)) return resolve(explicit);

  const candidate = resolve(join(homedir(), ".local", "bin", "hermes"));
  return isExecutable(candidate) ? candidate : null;
}

export function detectHermesRepoPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.HERMES_REPO_PATH;
  if (explicit && isDirectoryReadable(explicit)) return resolve(explicit);

  const candidate = resolve(join(homedir(), ".hermes", "hermes-agent"));
  return isDirectoryReadable(candidate) ? candidate : null;
}

export function detectHermes(): HermesDiscovery {
  return {
    binaryPath: detectHermesBinaryPath(),
    repoPath: detectHermesRepoPath(),
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectoryReadable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
