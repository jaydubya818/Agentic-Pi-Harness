import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MockModelClient } from "../adapter/pi-adapter.js";
import { ReplayRecorder } from "../replay/recorder.js";
import { EffectRecorder } from "../effect/recorder.js";
import { runQueryLoop } from "../loop/query.js";
import { writeProvenance, digestPolicy } from "../session/provenance.js";
import { StreamEvent } from "../schemas/index.js";

/**
 * Golden-path runner: drives the loop with a scripted mock model that
 * reads tests/math.test.ts and then writes a patched version.
 */
export interface RunOptions {
  /** If set, writes every stream event as JSONL to `<tracePath>`. */
  tracePath?: string;
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

  const script: StreamEvent[] = [
    { type: "message_start", schemaVersion: 1 },
    { type: "text_delta", schemaVersion: 1, text: "Reading failing test." },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: target } },
    { type: "text_delta", schemaVersion: 1, text: "Patching." },
    { type: "tool_use", schemaVersion: 1, id: "t2", name: "write_file",
      input: { path: target, content: "test('adds', () => { expect(1 + 1).toBe(2); });\n" } },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];

  const tape = new ReplayRecorder(tapePath);
  await tape.writeHeader({
    sessionId, loopGitSha: "dev", policyDigest: digestPolicy({ mode: "assist" }),
    costTableVersion: "2026-04-01",
  });

  const model = new MockModelClient(script);
  const effects = new EffectRecorder();

  const tracePath = opts.tracePath;
  const result = await runQueryLoop({
    sessionId, model, tape, effects,
    checkpointPath: join(sessionDir, "checkpoint.json"),
    effectLogPath: effectLog,
    policyLogPath: policyLog,
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

  await writeProvenance(join(sessionDir, "provenance.json"), {
    schemaVersion: 1,
    sessionId,
    loopGitSha: "dev",
    repoGitSha: null,
    provider: "mock",
    model: "mock-1",
    costTableVersion: "2026-04-01",
    piMdDigest: null,
    policyDigest: digestPolicy({ mode: "assist" }),
    createdAt: new Date().toISOString(),
  });

  await writeFile(join(sessionDir, "metrics.json"), JSON.stringify(result.counters, null, 2));
  return sessionId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // argv: [node, run.ts, workdir?, outRoot?, --trace[=path]?]
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let tracePath: string | undefined;
  for (const a of args) {
    if (a === "--trace") {
      // Default trace sink: ~/.pi/traces/<sessionId>.jsonl (path resolved after sessionId is known)
      tracePath = "__default__";
    } else if (a.startsWith("--trace=")) {
      tracePath = a.slice("--trace=".length);
    } else {
      positional.push(a);
    }
  }
  const workdir = positional[0] ?? "./.pi-work";
  const outRoot = positional[1] ?? "./.pi-out";
  (async () => {
    // Default trace path needs a sessionId, so resolve lazily inside runGoldenPath.
    let resolvedTrace = tracePath;
    if (tracePath === "__default__") {
      resolvedTrace = join(homedir(), ".pi", "traces", "latest.jsonl");
      await mkdir(join(homedir(), ".pi", "traces"), { recursive: true });
    }
    const id = await runGoldenPath(workdir, outRoot, { tracePath: resolvedTrace });
    console.log("session " + id);
    if (resolvedTrace) console.log("trace " + resolvedTrace);
  })();
}
