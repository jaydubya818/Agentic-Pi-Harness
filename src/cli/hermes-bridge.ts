#!/usr/bin/env node
import { detectHermes } from "../hermes/index.js";
import { HermesBridgeServer } from "../hermes/httpBridge.js";

interface BridgeArgs {
  host: string;
  port: number;
  command?: string;
  authToken?: string;
  stateRoot?: string;
}

function parseArgs(argv: string[]): BridgeArgs {
  const args: BridgeArgs = {
    host: "127.0.0.1",
    port: 8787,
    authToken: process.env.PI_HERMES_BRIDGE_TOKEN,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      args.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      args.port = Number(next);
      i += 1;
    } else if (arg === "--command" && next) {
      args.command = next;
      i += 1;
    } else if (arg === "--auth-token" && next) {
      args.authToken = next;
      i += 1;
    } else if (arg === "--state-root" && next) {
      args.stateRoot = next;
      i += 1;
    }
  }

  return args;
}

export async function runHermesBridgeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const detected = detectHermes();
  const server = new HermesBridgeServer({
    host: args.host,
    port: args.port,
    authToken: args.authToken,
    stateRoot: args.stateRoot,
    adapterOptions: { command: args.command ?? detected.binaryPath ?? undefined },
  });
  const listening = await server.start();
  console.log(JSON.stringify({
    ok: true,
    ...listening,
    hermes_binary_path: args.command ?? detected.binaryPath ?? null,
    hermes_repo_path: detected.repoPath,
    auth_required: Boolean(args.authToken),
    state_root: server.stateRoot,
  }, null, 2));

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesBridgeCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
