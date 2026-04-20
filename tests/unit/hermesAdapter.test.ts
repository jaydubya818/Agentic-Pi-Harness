import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAdapter } from "../../src/hermes/adapter.js";
import { HermesTaskRequestSchema } from "../../src/hermes/contracts.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

async function createAdapter() {
  return new HermesAdapter({
    command: process.execPath,
    commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
    stateRoot: await makeTempDir("pi-hermes-state-"),
    preferTransport: "subprocess",
  });
}

describe("HermesAdapter", () => {
  it("runs a one-shot Hermes task and collects a structured result", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_1",
      session_id: session.session_id,
      objective: "Write a report to the output dir and summarize it.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read", "write"],
      timeout_seconds: 10,
      output_dir: outputDir,
      metadata: {
        mission_id: "mission-1",
        run_id: "run-1",
        step_id: "step-1",
      },
    });

    await adapter.send_task(session.session_id, request);
    const result = await adapter.collect_result(session.session_id);
    const eventLog = await readFile(join(outputDir, ".pi-hermes", "events.jsonl"), "utf8");

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Fake Hermes completed successfully");
    expect(result.artifacts[0]?.type).toBe("report");
    expect(result.artifacts[0]?.path).toContain("report.md");
    expect(eventLog).toContain("task.started");
    expect(eventLog).toContain("task.output");
    expect(eventLog).toContain("task.completed");
  }, 15000);

  it("interrupts an active Hermes task", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_interrupt",
      session_id: session.session_id,
      objective: "__SLOW__ keep working until interrupted.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: {
        mission_id: "mission-2",
        run_id: "run-2",
        step_id: "step-2",
      },
    });

    await adapter.send_task(session.session_id, request);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await adapter.interrupt(session.session_id);

    const result = await adapter.collect_result(session.session_id);
    expect(result.status).toBe("interrupted");
    expect(result.summary).toContain("interrupted");
  }, 15000);
});
