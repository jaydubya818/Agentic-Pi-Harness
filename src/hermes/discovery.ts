import { accessSync, constants as fsConstants, statSync } from "node:fs";
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
    // X_OK passes for directories (searchable), so a directory named
    // "hermes" would be reported as the worker binary. Only files count.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectoryReadable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    // R_OK passes for regular files too, so a *file* named
    // "hermes-agent" (or a HERMES_REPO_PATH pointing at one) was reported
    // as the worker repo root. Every consumer treats repoPath as a
    // directory, so only directories count.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
