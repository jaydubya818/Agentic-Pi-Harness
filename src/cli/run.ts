import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createGoldenPathMockModelClient } from "../adapter/pi-adapter.js";
import { ReplayRecorder } from "../replay/recorder.js";
import { EffectRecorder } from "../effect/recorder.js";
import { runQueryLoop } from "../loop/query.js";
import { writeSessionStartProvenance, digestPolicy } from "../session/provenance.js";
/**
 * Golden-path runner: drives the loop with a scripted mock model that
 * reads tests/math.test.ts and then writes a patched version.
 */
export interface RunOptions {
  /** If set, writes every stream event as JSONL to `<tracePath>`. */
  tracePath?: string;
}

export interface ParsedRunCliArgs {
  workdir: string;
  outRoot: string;
  tracePath?: string;
}

export async function parseRunCliArgs(args: string[]): Promise<ParsedRunCliArgs> {
  const positional: string[] = [];
  let tracePath: string | undefined;

  for (const arg of args) {
    if (arg === "--trace") {
      tracePath = "__default__";
    } else if (arg.startsWith("--trace=")) {
      tracePath = arg.slice("--trace=".length);
    } else {
      positional.push(arg);
    }
  }

  let resolvedTrace = tracePath;
  if (tracePath === "__default__") {
    const traceDir = join(homedir(), ".pi", "traces");
    await mkdir(traceDir, { recursive: true });
    resolvedTrace = join(traceDir, "latest.jsonl");
  }

  return {
    workdir: positional[0] ?? "./.pi-work",
    outRoot: positional[1] ?? "./.pi-out",
    tracePath: resolvedTrace,
  };
}

export async function runGoldenPath(workdir: string, outRoot: string, opts: RunOptions = {}): Promise<string> {
  // ms timestamp + random suffix so two runs in the same second never collide
  const sessionId = "golden-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
  const sessionDir = join(outRoot, "sessions", sessionId);
  const tapePath = join(outRoot, "tapes", sessionId + ".jsonl");
  const effectLog = join(outRoot, "effects", sessionId + ".jsonl");
  const policyLog = join(sessionDir, "policy.jsonl");
  await mkdir(sessionDir, { recursive: true });

  const targetRel = "tests/math.test.ts";
  const target = join(workdir, targetRel);
  await mkdir(join(workdir, "tests"), { recursive: true });
  await writeFile(target, "test('adds', () => { expect(1 + 1).toBe(3); });\n");

  const policyDigest = digestPolicy({ mode: "assist" });

  await writeSessionStartProvenance(join(sessionDir, "provenance.json"), {
    sessionId,
    loopGitSha: "dev",
    repoGitSha: null,
    provider: "mock",
    model: "mock-1",
    costTableVersion: "2026-04-01",
    piMdDigest: null,
    policyDigest,
  });

  const tape = new ReplayRecorder(tapePath);
  await tape.writeHeader({
    sessionId, loopGitSha: "dev", policyDigest,
    costTableVersion: "2026-04-01",
  });

  const model = createGoldenPathMockModelClient({ targetPath: target });
  const effects = new EffectRecorder();

  const tracePath = opts.tracePath;
  try {
    const result = await runQueryLoop({
      sessionId, model, tape, effects,
      checkpointPath: join(sessionDir, "checkpoint.json"),
      effectLogPath: effectLog,
      policyLogPath: policyLog,
      policyMode: "placeholder",
      policyDigest,
      tracePath,
      tools: {
        read_file: async (i: { path: string }) => ({
          output: await readFile(i.path, "utf8"), paths: [i.path],
        }),
        write_file: async (i: { path: string; content: string }) => {
          await writeFile(i.path, i.content);
          return { output: `wrote ${i.path}`, paths: [i.path] };
        },
      },
    });

    await writeFile(join(sessionDir, "metrics.json"), JSON.stringify(result.counters, null, 2));
    return sessionId;
  } finally {
    await tape.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const parsed = await parseRunCliArgs(process.argv.slice(2));
    const id = await runGoldenPath(parsed.workdir, parsed.outRoot, { tracePath: parsed.tracePath });
    console.log("session " + id);
    if (parsed.tracePath) console.log("trace " + parsed.tracePath);
  })();
}
