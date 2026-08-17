import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAdapter, __adapterTestables } from "../../src/hermes/adapter.js";
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

  it("captures the trailing session footer, not a mid-output session_id mention", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_decoy_session",
      session_id: session.session_id,
      objective: "__DECOY_SESSION__ mention session ids mid-output.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 10,
      output_dir: outputDir,
      metadata: {
        mission_id: "mission-decoy",
        run_id: "run-decoy",
        step_id: "step-decoy",
      },
    });

    await adapter.send_task(session.session_id, request);
    const result = await adapter.collect_result(session.session_id);

    expect(result.status).toBe("completed");
    // The adapter mutates the session record it returned from start_session.
    expect(session.hermes_session_id).toBe("fake-hermes-session");
  }, 15000);

  it("settles the run with a failure instead of crashing when exit finalization throws", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const makeRequest = (requestId: string) => HermesTaskRequestSchema.parse({
      request_id: requestId,
      session_id: session.session_id,
      objective: "Quick task.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 10,
      output_dir: outputDir,
      metadata: { mission_id: "mission-finalize", run_id: "run-finalize", step_id: "step-finalize" },
    });

    const internals = adapter as unknown as { pushEvent: (...args: unknown[]) => Promise<void> };
    const originalPushEvent = internals.pushEvent.bind(adapter);

    await adapter.send_task(session.session_id, makeRequest("req_finalize_fail"));
    // Sabotage event persistence: the terminal-event push inside handleExit
    // now throws. Previously that rejection escaped a bare `void` call as an
    // unhandledRejection and the completion promise never settled.
    internals.pushEvent = async () => {
      throw new Error("simulated event log failure");
    };

    await expect(adapter.collect_result(session.session_id)).rejects.toThrow("simulated event log failure");

    // The session must be released so the next task can run.
    internals.pushEvent = originalPushEvent;
    await adapter.send_task(session.session_id, makeRequest("req_finalize_recover"));
    const result = await adapter.collect_result(session.session_id);
    expect(result.status).toBe("completed");
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

  it("caps in-memory session event retention while the on-disk log keeps the full history", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDirA = await makeTempDir("pi-hermes-out-");
    const outputDirB = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter({ maxRetainedSessionEvents: 50 });
    const session = await adapter.start_session(workdir);

    const makeRequest = (requestId: string, outputDir: string) => HermesTaskRequestSchema.parse({
      request_id: requestId,
      session_id: session.session_id,
      objective: "__NOISY__ flood stdout, then emit the structured result.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read", "write"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: { mission_id: "mission-retention", run_id: "run-retention", step_id: "step-retention" },
    });

    const firstAccepted = await adapter.send_task(session.session_id, makeRequest("req_retention_1", outputDirA));
    await adapter.collect_result(session.session_id);

    // The retained in-memory window is capped, but the on-disk event log
    // still carries the execution's full history.
    const retained: string[] = [];
    for await (const event of adapter.read_events(session.session_id, firstAccepted.execution_id)) {
      retained.push(event.type);
    }
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(50);
    expect(retained[retained.length - 1]).toBe("task.completed");
    const eventLog = await readFile(join(outputDirA, ".pi-hermes", "events.jsonl"), "utf8");
    expect(eventLog.split("\n").filter(Boolean).length).toBeGreaterThan(1000);

    // A second noisy execution trims the first one's events out of the
    // retained window entirely; a late reader for the first execution must
    // still terminate instead of parking forever on a waiter.
    await adapter.send_task(session.session_id, makeRequest("req_retention_2", outputDirB));
    await adapter.collect_result(session.session_id);

    const lateRead = (async () => {
      let count = 0;
      for await (const _event of adapter.read_events(session.session_id, firstAccepted.execution_id)) {
        count += 1;
      }
      return count;
    })();
    const outcome = await Promise.race([
      lateRead.then(() => "done"),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise("hung"), 2000)),
    ]);
    expect(outcome).toBe("done");
  }, 20000);

  it("caps the buffered partial line when a worker streams a giant newline-free line", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter({ maxRetainedOutputChars: 4096 });
    const session = await adapter.start_session(workdir);

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_test_megaline",
      session_id: session.session_id,
      objective: "__MEGALINE__ stream one enormous line, then emit the structured result.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read", "write"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: { mission_id: "mission-megaline", run_id: "run-megaline", step_id: "step-megaline" },
    });

    await adapter.send_task(session.session_id, request);
    const result = await adapter.collect_result(session.session_id);

    expect(result.status).toBe("completed");
    expect(result.structured_output).toBe(true);
    // The ~320KB newline-free line must be retained (and emitted) only up to
    // the cap plus at most one trailing chunk, not buffered in full.
    const eventLog = await readFile(join(outputDir, ".pi-hermes", "events.jsonl"), "utf8");
    const outputLines = eventLog
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: { line?: string } })
      .filter((event) => event.type === "task.output")
      .map((event) => String(event.data?.line ?? ""));
    const longest = Math.max(...outputLines.map((line) => line.length));
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(4096 + 65536);
    // The full stream still lands on disk regardless of the in-memory cap.
    const rawLog = await readFile(join(outputDir, ".pi-hermes", "hermes.raw.log"), "utf8");
    expect(rawLog.length).toBeGreaterThan(300000);
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

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "keeps artifacts from readable directories when a subdirectory is unreadable",
    async () => {
      const { chmod, mkdir, writeFile } = await import("node:fs/promises");
      const outputDir = await makeTempDir("pi-hermes-artifacts-");
      await writeFile(join(outputDir, "report.md"), "# hi\n", "utf8");
      const locked = join(outputDir, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "hidden.txt"), "secret\n", "utf8");
      await chmod(locked, 0o000);
      try {
        const artifacts = await __adapterTestables.detectArtifacts(outputDir);
        expect(artifacts.map((artifact) => artifact.path)).toEqual([resolve(join(outputDir, "report.md"))]);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it("bounds artifact discovery by depth and count", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const outputDir = await makeTempDir("pi-hermes-artifact-bounds-");

    // Deeper than the depth bound under test: files past it are not reported.
    let deep = outputDir;
    for (let level = 0; level < 5; level++) {
      deep = join(deep, `level-${level}`);
      await mkdir(deep);
      await writeFile(join(deep, "note.txt"), "x\n", "utf8");
    }
    // Wider than the count bound under test.
    for (let index = 0; index < 6; index++) {
      await writeFile(join(outputDir, `a-${index}.txt`), "x\n", "utf8");
    }

    const depthBounded = await __adapterTestables.detectArtifacts(outputDir, { maxDepth: 2, maxArtifacts: 1000 });
    expect(depthBounded.some((artifact) => artifact.path.includes("level-4"))).toBe(false);
    expect(depthBounded.some((artifact) => artifact.path.includes("level-1"))).toBe(true);

    const countBounded = await __adapterTestables.detectArtifacts(outputDir, { maxDepth: 24, maxArtifacts: 3 });
    expect(countBounded).toHaveLength(3);

    // The shipped defaults are generous enough that ordinary runs are
    // unaffected by either bound.
    expect(__adapterTestables.DEFAULT_ARTIFACT_SCAN_LIMITS.maxDepth).toBeGreaterThanOrEqual(16);
    expect(__adapterTestables.DEFAULT_ARTIFACT_SCAN_LIMITS.maxArtifacts).toBeGreaterThanOrEqual(1000);
    const unbounded = await __adapterTestables.detectArtifacts(outputDir);
    expect(unbounded).toHaveLength(11);
  });

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

      // The persisted event log must also terminate: task.started with no
      // terminal record would look like a run that never finished.
      const eventLog = await readFile(join(outputDir, ".pi-hermes", "events.jsonl"), "utf8");
      const persistedTypes = eventLog.trim().split("\n").map((line) => JSON.parse(line).type);
      expect(persistedTypes[persistedTypes.length - 1]).toBe("task.failed");

      // The rejected completion promise has no consumer on this path; give
      // the microtask queue a beat and assert nothing surfaced unhandled.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("kills the spawned worker when accept bookkeeping fails after spawn", async () => {
    const workdir = await makeTempDir("pi-hermes-work-");
    const outputDir = await makeTempDir("pi-hermes-out-");
    const adapter = await createAdapter();
    const session = await adapter.start_session(workdir);

    const internals = adapter as unknown as {
      pushEvent: (session: unknown, event: { type: string; data?: Record<string, unknown> }) => Promise<void>;
    };
    const originalPushEvent = internals.pushEvent.bind(adapter);

    let workerPid: number | null = null;
    internals.pushEvent = async (storedSession, event) => {
      // The post-spawn progress event is the first bookkeeping step that
      // runs with a live worker behind it. Fail it there.
      if (event.type === "task.progress" && typeof event.data?.pid === "number") {
        workerPid = event.data.pid as number;
        internals.pushEvent = originalPushEvent;
        throw new Error("simulated post-spawn bookkeeping failure");
      }
      return originalPushEvent(storedSession, event);
    };

    const request = HermesTaskRequestSchema.parse({
      request_id: "req_post_spawn_fail",
      session_id: session.session_id,
      execution_id: "exec_post_spawn_fail",
      objective: "__SLOW__ keep running until something reaps me.",
      workdir,
      allowed_tools: [],
      allowed_actions: ["read"],
      timeout_seconds: 30,
      output_dir: outputDir,
      metadata: { mission_id: "m", run_id: "r", step_id: "s" },
    });

    await expect(adapter.send_task(session.session_id, request)).rejects.toThrow("simulated post-spawn bookkeeping failure");
    expect(workerPid).toBeTypeOf("number");

    // The abandoned run is no longer supervised (handleExit bails once the
    // session released it), so the worker must have been killed on the way
    // out rather than left running for its whole timeout budget.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(workerPid as unknown as number, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  }, 15000);

  it("strips terminal erase characters without touching lines that have none", () => {
    const { stripAnsi } = __adapterTestables;

    const plain = "2026-01-01T00:00:00Z INFO worker line";
    expect(stripAnsi(plain)).toBe(plain);
    expect(stripAnsi("abc\b\bZ")).toBe("aZ");
    expect(stripAnsi("ab\u007fc")).toBe("ac");
    // Erasing past the start of the buffer must not underflow.
    expect(stripAnsi("\b\b\bx")).toBe("x");
    // ANSI escapes are still removed alongside the erase handling.
    expect(stripAnsi("\u001B[32mok\u001B[0m")).toBe("ok");
  });
});
