#!/usr/bin/env node
import { readPiRuntimeConfig } from "../config/runtime.js";
import { AgenticKbMemoryProvider } from "../memory/agenticKbMemoryProvider.js";

interface MemoryCliArgs {
  command: "search" | "read" | "context";
  value: string;
  project?: string;
  kbPath?: string;
  accessMode?: "auto" | "local" | "http" | "disabled";
}

function parseArgs(argv: string[]): MemoryCliArgs {
  const [command, value, ...rest] = argv;
  if (!command || !value || !["search", "read", "context"].includes(command)) {
    throw new Error("usage: pi-harness memory <search|read|context> <query|slug|agent-id> [--project <name>] [--kb-path <path>] [--access-mode <auto|local|http|disabled>]");
  }

  const args: MemoryCliArgs = {
    command: command as MemoryCliArgs["command"],
    value,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];
    if (arg === "--project" && next) {
      args.project = next;
      index += 1;
    } else if (arg === "--kb-path" && next) {
      args.kbPath = next;
      index += 1;
    } else if (arg === "--access-mode" && next && ["auto", "local", "http", "disabled"].includes(next)) {
      args.accessMode = next as MemoryCliArgs["accessMode"];
      index += 1;
    }
  }

  return args;
}

export async function runMemoryCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const config = readPiRuntimeConfig(process.env);
  const provider = new AgenticKbMemoryProvider({
    kbRoot: args.kbPath ?? config.agenticKbPath,
    apiUrl: config.kbApiUrl,
    accessMode: args.accessMode ?? config.agenticKbAccessMode,
    maxResults: config.agenticKbMaxResults,
    contextBudgetChars: config.agenticKbContextBudgetChars,
    privatePin: config.privatePin,
    anthropicApiKey: config.anthropicApiKey,
  });

  if (args.command === "search") {
    console.log(JSON.stringify(await provider.search(args.value), null, 2));
    return;
  }
  if (args.command === "read") {
    console.log(JSON.stringify(await provider.get(args.value), null, 2));
    return;
  }
  console.log(JSON.stringify(await provider.loadAgentContext(args.value, { project: args.project }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMemoryCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
