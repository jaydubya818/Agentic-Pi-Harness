import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeStateIdSegment, HermesBridgeStateStore } from "../../src/hermes/bridgeState.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HermesBridgeStateStore", () => {
  it("retries a failed init instead of caching the stale rejection", async () => {
    const base = await makeTempDir("pi-bridge-state-init-");
    const blocker = join(base, "state");
    // A regular file where the state root should be makes both mkdirs fail.
    await writeFile(blocker, "not a directory", "utf8");
    const store = new HermesBridgeStateStore(blocker);
    await expect(store.init()).rejects.toThrow();

    // Once the obstruction is gone, the memoized init must retry rather
    // than replay the cached rejection forever.
    await rm(blocker, { force: true });
    await store.init();
    await store.appendPreflightDenial({ at: "2026-08-09T00:00:00Z", code: "ok", message: "after retry" });
    const denials = await store.loadPreflightDenials();
    expect(denials.map((denial) => denial.code)).toEqual(["ok"]);
  });

  it("skips corrupt preflight denial lines instead of dropping the whole log", async () => {
    const root = await makeTempDir("pi-bridge-state-denials-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    await store.appendPreflightDenial({ at: "2026-07-23T00:00:00Z", code: "one", message: "first" });
    await appendFile(join(root, "preflight-denials.jsonl"), '{"torn":', "utf8");
    await appendFile(join(root, "preflight-denials.jsonl"), "\n", "utf8");
    await store.appendPreflightDenial({ at: "2026-07-23T00:00:01Z", code: "two", message: "second" });

    const denials = await store.loadPreflightDenials();
    expect(denials.map((denial) => denial.code)).toEqual(["one", "two"]);
  });

  it("tails the denial log without reading records older than the requested limit", async () => {
    const root = await makeTempDir("pi-bridge-state-denial-tail-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    // Well past the 64 KiB starting tail window so the read genuinely has to
    // seek rather than swallowing the file whole.
    const total = 2000;
    for (let index = 0; index < total; index++) {
      await store.appendPreflightDenial({
        at: "2026-08-16T00:00:00Z",
        code: `denial-${index}`,
        message: "x".repeat(200),
      });
    }

    const tail = await store.loadPreflightDenials(3);
    // The tail window holds more than three lines; the caller slices. What
    // matters is that the newest records are present and every returned
    // record parsed cleanly (no torn line at the window boundary).
    expect(tail.length).toBeGreaterThanOrEqual(3);
    expect(tail.length).toBeLessThan(total);
    expect(tail.slice(-3).map((denial) => denial.code)).toEqual([
      `denial-${total - 3}`,
      `denial-${total - 2}`,
      `denial-${total - 1}`,
    ]);
    for (const denial of tail) expect(denial.message).toHaveLength(200);

    // No limit still returns the complete history.
    const all = await store.loadPreflightDenials();
    expect(all).toHaveLength(total);
    expect(all[0].code).toBe("denial-0");
  });

  it("tails a denial log smaller than one read window", async () => {
    const root = await makeTempDir("pi-bridge-state-denial-small-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    expect(await store.loadPreflightDenials(5)).toEqual([]);
    await store.appendPreflightDenial({ at: "2026-08-16T00:00:00Z", code: "only", message: "m" });
    expect((await store.loadPreflightDenials(5)).map((denial) => denial.code)).toEqual(["only"]);
  });

  it("skips a torn trailing run-event line instead of dropping the whole event log", async () => {
    const root = await makeTempDir("pi-bridge-state-events-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    const event = {
      type: "task.progress" as const,
      session_id: "sess_x",
      execution_id: "exec_torn_1",
      at: "2026-08-02T00:00:00Z",
      data: {},
    };
    await store.appendRunEvent("exec_torn_1", event);
    // Simulate a crash mid-append: a partial JSON line with no newline.
    await appendFile(join(root, "runs", "exec_torn_1", "events.jsonl"), '{"type":"task.out', "utf8");
    await store.persistRun({
      accepted: { request_id: "req_1", session_id: "sess_x", execution_id: "exec_torn_1", status: "accepted" },
      request: {
        request_id: "req_1",
        session_id: "sess_x",
        execution_id: "exec_torn_1",
        objective: "obj",
        workdir: "/tmp",
        allowed_tools: [],
        allowed_actions: ["read"],
        timeout_seconds: 5,
        output_dir: "/tmp",
        metadata: { mission_id: "m", run_id: "r", step_id: "s" },
      },
      status: "running",
      session: {
        session_id: "sess_x",
        workdir: "/tmp",
        profile: null,
        runtime_dir: "/tmp",
        hermes_session_id: null,
        status: "running",
        created_at: "2026-08-02T00:00:00Z",
      },
      events: [event],
      result: null,
      error: null,
    });

    const snapshot = await store.load();
    const run = snapshot.runs.find((item) => item.accepted.execution_id === "exec_torn_1");
    expect(run).toBeDefined();
    expect(run!.events).toHaveLength(1);
    expect(run!.events[0]).toMatchObject({ type: "task.progress", execution_id: "exec_torn_1" });
  });

  it("refuses execution and session ids that are not safe path segments", async () => {
    for (const bad of ["../escape", "a/b", "a\\b", ".", "..", "a\0b", ""]) {
      expect(() => assertSafeStateIdSegment(bad, "execution_id")).toThrow(/not a safe path segment/);
    }
    expect(assertSafeStateIdSegment("exec_abc123", "execution_id")).toBe("exec_abc123");

    const root = await makeTempDir("pi-bridge-state-unsafe-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    await expect(store.appendRunEvent("../escaped", {
      type: "task.progress",
      session_id: "sess_x",
      execution_id: "../escaped",
      at: "2026-07-23T00:00:00Z",
      data: {},
    })).rejects.toThrow(/not a safe path segment/);
  });
});
