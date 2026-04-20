#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectHermes, HermesAdapter, HermesTaskRequestSchema } from "../hermes/index.js";

interface SmokeArgs {
  workdir: string;
  outputDir: string;
  timeoutSeconds: number;
  profile?: string;
  command?: string;
}

function parseArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = {
    workdir: process.cwd(),
    outputDir: resolve(process.cwd(), ".pi-hermes-smoke"),
    timeoutSeconds: 240,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--workdir" && next) {
      args.workdir = resolve(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolve(next);
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
    }
  }

  return args;
}

export async function runHermesSmoke(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (process.env.BRIDGE_ONLY_GOVERNED_EXECUTION === "true" && process.env.DEV_BYPASS_DIRECT_HERMES !== "true") {
    throw new Error("direct HermesAdapter execution is disabled by BRIDGE_ONLY_GOVERNED_EXECUTION; use the bridge or set DEV_BYPASS_DIRECT_HERMES=true for dev-only tooling");
  }
  console.warn("[dev-only] hermes-smoke uses the direct HermesAdapter path and bypasses bridge KB policy enforcement.");
  await mkdir(args.outputDir, { recursive: true });

  const detected = detectHermes();
  const adapter = new HermesAdapter({ command: args.command ?? detected.binaryPath ?? undefined });
  const session = await adapter.start_session(args.workdir, { profile: args.profile });

  const firstPath = join(args.outputDir, "smoke-1.md");
  const secondPath = join(args.outputDir, "smoke-2.md");

  const request1 = HermesTaskRequestSchema.parse({
    request_id: "req_smoke_1",
    session_id: session.session_id,
    objective: `Create ${firstPath} with a one-sentence message proving Hermes completed smoke step 1. Return the required structured result block only.`,
    workdir: args.workdir,
    allowed_tools: ["bash"],
    allowed_actions: ["write"],
    timeout_seconds: args.timeoutSeconds,
    output_dir: args.outputDir,
    metadata: {
      mission_id: "smoke-mission",
      run_id: "smoke-run-1",
      step_id: "smoke-step-1",
    },
  });

  await adapter.send_task(session.session_id, request1);
  const result1 = await adapter.collect_result(session.session_id);

  const request2 = HermesTaskRequestSchema.parse({
    request_id: "req_smoke_2",
    session_id: session.session_id,
    objective: `Create ${secondPath} with a one-sentence message proving Hermes completed smoke step 2 in the same supervised session. Return the required structured result block only.`,
    workdir: args.workdir,
    allowed_tools: ["bash"],
    allowed_actions: ["write"],
    timeout_seconds: args.timeoutSeconds,
    output_dir: args.outputDir,
    metadata: {
      mission_id: "smoke-mission",
      run_id: "smoke-run-2",
      step_id: "smoke-step-2",
    },
  });

  await adapter.send_task(session.session_id, request2);
  const result2 = await adapter.collect_result(session.session_id);
  const sessionState = JSON.parse(await readFile(join(session.runtime_dir, "session.json"), "utf8")) as {
    hermes_session_id?: string | null;
  };

  console.log(JSON.stringify({
    hermes_binary_path: args.command ?? detected.binaryPath ?? null,
    hermes_repo_path: detected.repoPath,
    session,
    hermes_session_id: sessionState.hermes_session_id ?? null,
    first: result1,
    second: result2,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
