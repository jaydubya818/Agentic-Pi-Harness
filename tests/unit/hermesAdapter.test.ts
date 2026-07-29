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

async function createAdapter(options: { maxRetainedOutputChars?: number } = {}) {
  return new HermesAdapter({
    command: process.execPath,
    commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
    stateRoot: await makeTempDir("pi-hermes-state-"),
    preferTransport: "subprocess",
    ...options,
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

  it("cancel and interrupt scoped to a stale execution_id do not touch the active execution", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_scoped_cancel",
      session_id: session.session_id,
      execution_id: "exec_scoped_active",
      objective: "__SLOW__ keep working until cancelled.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: {
        mission_id: "mission-scoped",
        run_id: "run-scoped",
        step_id: "step-scoped",
      },
    });

    await adapter.send_task(session.session_id, request);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    // Aimed at an execution that is not the active one: must be a no-op.
    await adapter.cancel(session.session_id, "exec_finished_earlier");
    await adapter.interrupt(session.session_id, "exec_finished_earlier");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    const pending = await Promise.race([
      adapter.collect_result(session.session_id).then((result) => result.status),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise("still-running"), 500)),
    ]);
    expect(pending).toBe("still-running");

    // Aimed at the active execution: cancels it.
    await adapter.cancel(session.session_id, "exec_scoped_active");
    const result = await adapter.collect_result(session.session_id);
    expect(result.status).toBe("cancelled");
  }, 15000);

  it("read_events terminates instead of hanging when the session is closed", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const iterator = adapter.read_events(session.session_id);
    const pendingNext = iterator.next();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await adapter.close_session(session.session_id);

    const outcome = await Promise.race([
      pendingNext.then((result) => (result.done ? "done" : "event")),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise("hung"), 2000)),
    ]);
    expect(outcome).toBe("done");
  }, 15000);

  it("still parses the structured result when output exceeds the retention cap", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter({ maxRetainedOutputChars: 4096 });
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_noisy",
      session_id: session.session_id,
      objective: "__NOISY__ flood stdout, then emit the structured result.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read", "write"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: { mission_id: "mission-4", run_id: "run-4", step_id: "step-4" },
    });

    await adapter.send_task(session.session_id, request);
    const result = await adapter.collect_result(session.session_id);

    expect(result.status).toBe("completed");
    expect(result.structured_output).toBe(true);
    expect(result.summary).toContain("Fake Hermes completed successfully");
    // The full stream still lands on disk even though memory retention is capped.
    const rawLog = await readFile(join(outputDir, ".pi-hermes", "hermes.raw.log"), "utf8");
    expect(rawLog.length).toBeGreaterThan(100000);
  }, 15000);

  it("cancel force-kill timer does not kill a subsequent execution", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const makeRequest = (requestId: string) => HermesTaskRequestSchema.parse({
      request_id: requestId,
      session_id: session.session_id,
      objective: "__SLOW__ keep working until cancelled.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: { mission_id: "mission-3", run_id: "run-3", step_id: "step-3" },
    });

    await adapter.send_task(session.session_id, makeRequest("req_test_cancel_1"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    // Double-cancel: the second call used to overwrite forceKillHandle,
    // orphaning the first force-kill timer so exit cleanup never cleared it.
    await adapter.cancel(session.session_id);
    await adapter.cancel(session.session_id);
    const first = await adapter.collect_result(session.session_id);
    expect(first.status).toBe("cancelled");

    // Start a second slow execution immediately, then wait past the 3s
    // force-kill window of the first cancel. The orphaned timer used to
    // re-read session.active and SIGKILL this new execution.
    await adapter.send_task(session.session_id, makeRequest("req_test_cancel_2"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3500));

    const second = adapter.collect_result(session.session_id);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(secondSettled).toBe(false);

    await adapter.cancel(session.session_id);
    const result = await second;
    expect(result.status).toBe("cancelled");
  }, 15000);

  it("settles watchers and the completion promise when spawn setup fails", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    // Empty command: child_process.spawn throws synchronously, exercising
    // the send_task catch path (worker never spawned).
    const adapter = new HermesAdapter({
      command: "",
      stateRoot: await makeTempDir("pi-hermes-state-"),
      preferTransport: "subprocess",
    });
    const session = await adapter.start_session(workdir);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const request = HermesTaskRequestSchema.parse({
        request_id: "req_spawnfail_1",
        session_id: session.session_id,
        execution_id: "exec_spawnfail_1",
        objective: "never runs",
        workdir,
        allowed_tools: [],
        allowed_actions: ["read"],
        timeout_seconds: 5,
        output_dir: outputDir,
        metadata: { mission_id: "m", run_id: "r", step_id: "s" },
      });

      await expect(adapter.send_task(session.session_id, request)).rejects.toThrow();

      // Watchers keyed to the caller-supplied execution id must terminate
      // instead of parking forever on a run whose worker never spawned.
      const seen: string[] = [];
      for await (const event of adapter.read_events(session.session_id, "exec_spawnfail_1")) {
        seen.push(event.type);
      }
      expect(seen[seen.length - 1]).toBe("task.failed");

      // The rejected completion promise has no consumer on this path; give
      // the microtask queue a beat and assert nothing surfaced unhandled.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
