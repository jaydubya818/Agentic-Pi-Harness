#!/usr/bin/env node
import { resolve } from "node:path";
import { detectHermes } from "../hermes/index.js";
import { runHermesSupervisorTask } from "../orchestration/hermesSupervisor.js";

interface CliArgs {
  workdir: string;
  outRoot: string;
  objective: string;
  timeoutSeconds: number;
  profile?: string;
  command?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workdir: process.cwd(),
    outRoot: resolve(process.cwd(), ".pi-hermes-out"),
    objective: "Create a short markdown report in the artifact directory describing what Hermes did.",
    timeoutSeconds: 900,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--workdir" && next) {
      args.workdir = resolve(next);
      i += 1;
    } else if (arg === "--out-root" && next) {
      args.outRoot = resolve(next);
      i += 1;
    } else if (arg === "--objective" && next) {
      args.objective = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      args.timeoutSeconds = Number(next);
      i += 1;
    } else if (arg === "--profile" && next) {
      args.profile = next;
      i += 1;
    } else if (arg === "--command" && next) {
      args.command = next;
      i += 1;
    } else if (arg === "--bridge-url" && next) {
      args.bridgeUrl = next;
      i += 1;
    } else if (arg === "--bridge-token" && next) {
      args.bridgeToken = next;
      i += 1;
    }
  }

  return args;
}

export async function runHermesRunCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const detected = detectHermes();
  const result = await runHermesSupervisorTask({
    objective: args.objective,
    workdir: args.workdir,
    outRoot: args.outRoot,
    timeoutSeconds: args.timeoutSeconds,
    profile: args.profile,
    bridgeUrl: args.bridgeUrl,
    bridgeToken: args.bridgeToken,
    adapterOptions: { command: args.command ?? detected.binaryPath ?? undefined },
  });
  console.log(JSON.stringify({
    hermes_binary_path: args.command ?? detected.binaryPath ?? null,
    hermes_repo_path: detected.repoPath,
    ...result,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesRunCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
