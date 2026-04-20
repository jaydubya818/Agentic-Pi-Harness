#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { detectHermes, HermesAdapter, HermesTaskRequestSchema } from "../hermes/index.js";

interface DemoArgs {
  workdir: string;
  outputDir: string;
  objective: string;
  timeoutSeconds: number;
  profile?: string;
  command?: string;
}

function parseArgs(argv: string[]): DemoArgs {
  const args: DemoArgs = {
    workdir: process.cwd(),
    outputDir: resolve(process.cwd(), ".pi-hermes-demo"),
    objective: "Review the current repository, write a short markdown report to the provided output dir, and summarize what you found.",
    timeoutSeconds: 300,
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
    }
  }

  return args;
}

export async function runHermesDemo(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (process.env.BRIDGE_ONLY_GOVERNED_EXECUTION === "true" && process.env.DEV_BYPASS_DIRECT_HERMES !== "true") {
    throw new Error("direct HermesAdapter execution is disabled by BRIDGE_ONLY_GOVERNED_EXECUTION; use the bridge or set DEV_BYPASS_DIRECT_HERMES=true for dev-only tooling");
  }
  console.warn("[dev-only] hermes-demo uses the direct HermesAdapter path and bypasses bridge KB policy enforcement.");
  await mkdir(args.outputDir, { recursive: true });

  const detected = detectHermes();
  const adapter = new HermesAdapter({ command: args.command ?? detected.binaryPath ?? undefined });
  const session = await adapter.start_session(args.workdir, { profile: args.profile });

  const request = HermesTaskRequestSchema.parse({
    request_id: "req_demo",
    session_id: session.session_id,
    objective: args.objective,
    workdir: args.workdir,
    allowed_tools: ["bash", "git", "python"],
    allowed_actions: ["read", "write", "patch", "test"],
    timeout_seconds: args.timeoutSeconds,
    output_dir: args.outputDir,
    metadata: {
      mission_id: "demo-mission",
      run_id: "demo-run",
      step_id: "demo-step",
    },
  });

  const accepted = await adapter.send_task(session.session_id, request);

  const eventPrinter = (async () => {
    for await (const event of adapter.read_events(session.session_id, accepted.execution_id)) {
      const line = event.type === "task.output"
        ? String(event.data.line ?? "")
        : JSON.stringify(event.data);
      console.log(`[${event.type}] ${line}`);
    }
  })();

  const result = await adapter.collect_result(session.session_id);
  await eventPrinter;

  console.log("\nFinal result:\n" + JSON.stringify({
    hermes_binary_path: args.command ?? detected.binaryPath ?? null,
    hermes_repo_path: detected.repoPath,
    result,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesDemo().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
