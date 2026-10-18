import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesBridgeStateStore } from "../../src/hermes/bridgeState.js";
import type { HermesSession } from "../../src/hermes/contracts.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function session(id: string, createdAt: string): HermesSession {
  return {
    session_id: id,
    workdir: "/tmp",
    profile: null,
    runtime_dir: "/tmp",
    hermes_session_id: null,
    status: "idle",
    created_at: createdAt,
  };
}

async function persistRun(
  store: HermesBridgeStateStore,
  executionId: string,
  sessionId: string,
  sessionCreatedAt: string,
  acceptedAt: string | undefined,
): Promise<void> {
  await store.persistRun({
    accepted: { request_id: `req_${executionId}`, session_id: sessionId, execution_id: executionId, status: "accepted" },
    acceptedAt,
    request: {
      request_id: `req_${executionId}`,
      session_id: sessionId,
      execution_id: executionId,
      objective: "obj",
      workdir: "/tmp",
      allowed_tools: [],
      allowed_actions: ["read"],
      timeout_seconds: 5,
      output_dir: "/tmp",
      metadata: { mission_id: "m", run_id: "r", step_id: "s" },
    },
    status: "running",
    session: session(sessionId, sessionCreatedAt),
    events: [],
    result: null,
    error: null,
  });
}

// GET /sessions and GET /runs both document ?limit=N as tailing the most
// recent records, and both implement that as `items.slice(-limit)` over Map
// insertion order. On a restart that insertion order comes from the restored
// snapshot, so the snapshot has to be ordered by something persisted rather
// than by `readdir`.
//
// These ids are chosen so the expected order matches neither the write order
// nor lexical name order: writing sess_a, sess_b, sess_c but with created_at
// putting sess_c first and sess_b last. A restore that echoes readdir order
// therefore fails whichever of the two orders the filesystem happens to
// return.
describe("bridge state restore ordering", () => {
  it("restores sessions in persisted created_at order, not readdir order", async () => {
    const root = await makeTempDir("pi-bridge-restore-sess-");
    const store = new HermesBridgeStateStore(root);
    await store.init();

    await store.persistSession(session("sess_a", "2026-08-02T00:00:00Z"));
    await store.persistSession(session("sess_b", "2026-08-03T00:00:00Z"));
    await store.persistSession(session("sess_c", "2026-08-01T00:00:00Z"));

    const snapshot = await new HermesBridgeStateStore(root).load();
    expect(snapshot.sessions.map((s) => s.session_id)).toEqual(["sess_c", "sess_a", "sess_b"]);

    // The tail an operator would get from GET /sessions?limit=2.
    expect(snapshot.sessions.slice(-2).map((s) => s.session_id)).toEqual(["sess_a", "sess_b"]);
  });

  it("restores runs in a stable order rather than readdir order", async () => {
    const root = await makeTempDir("pi-bridge-restore-runs-");
    const store = new HermesBridgeStateStore(root);
    await store.init();

    const persist = async (executionId: string, sessionId: string, createdAt: string) => {
      await store.persistRun({
        accepted: { request_id: `req_${executionId}`, session_id: sessionId, execution_id: executionId, status: "accepted" },
        request: {
          request_id: `req_${executionId}`,
          session_id: sessionId,
          execution_id: executionId,
          objective: "obj",
          workdir: "/tmp",
          allowed_tools: [],
          allowed_actions: ["read"],
          timeout_seconds: 5,
          output_dir: "/tmp",
          metadata: { mission_id: "m", run_id: "r", step_id: "s" },
        },
        status: "running",
        session: session(sessionId, createdAt),
        events: [],
        result: null,
        error: null,
      });
    };

    await persist("exec_a", "sess_a", "2026-08-02T00:00:00Z");
    await persist("exec_b", "sess_b", "2026-08-03T00:00:00Z");
    await persist("exec_c", "sess_c", "2026-08-01T00:00:00Z");

    const first = await new HermesBridgeStateStore(root).load();
    expect(first.runs.map((r) => r.accepted.execution_id)).toEqual(["exec_c", "exec_a", "exec_b"]);

    // Same bytes on disk must restore to the same order every time.
    const second = await new HermesBridgeStateStore(root).load();
    expect(second.runs.map((r) => r.accepted.execution_id))
      .toEqual(first.runs.map((r) => r.accepted.execution_id));
  });

  it("restores two runs on one session in acceptance order, which created_at cannot express", async () => {
    // The case the session-created_at proxy could never separate: three runs
    // on the SAME session tie on every field the old sort key looked at, so
    // the order fell through to the execution_id tie-break -- i.e. lexical
    // id order, not acceptance order. The ids below are deliberately in the
    // opposite order to acceptance.
    const root = await makeTempDir("pi-bridge-restore-accepted-");
    const store = new HermesBridgeStateStore(root);
    await store.init();

    await persistRun(store, "exec_z", "sess_one", "2026-08-01T00:00:00Z", "2026-08-01T10:00:00.000Z");
    await persistRun(store, "exec_m", "sess_one", "2026-08-01T00:00:00Z", "2026-08-01T11:00:00.000Z");
    await persistRun(store, "exec_a", "sess_one", "2026-08-01T00:00:00Z", "2026-08-01T12:00:00.000Z");

    const snapshot = await new HermesBridgeStateStore(root).load();
    expect(snapshot.runs.map((r) => r.accepted.execution_id)).toEqual(["exec_z", "exec_m", "exec_a"]);
    expect(snapshot.runs.map((r) => r.acceptedAt)).toEqual([
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    ]);

    // The tail an operator would get from GET /runs?limit=2 is now the two
    // most recently accepted runs rather than the two lexically-last ids.
    expect(snapshot.runs.slice(-2).map((r) => r.accepted.execution_id)).toEqual(["exec_m", "exec_a"]);
  });

  it("orders a run persisted without accepted_at against one that has it", async () => {
    // Backward compatibility: a record written before the field existed
    // still sorts by its session's created_at, and the two keys interleave
    // by instant rather than by string form. The legacy stamp below has no
    // sub-second component and the new one does, which is exactly the pair
    // a raw lexicographic compare gets backwards.
    const root = await makeTempDir("pi-bridge-restore-mixed-");
    const store = new HermesBridgeStateStore(root);
    await store.init();

    await persistRun(store, "exec_legacy", "sess_old", "2026-08-01T09:00:00Z", undefined);
    await persistRun(store, "exec_new", "sess_new", "2026-08-01T00:00:00Z", "2026-08-01T08:59:59.500Z");

    const snapshot = await new HermesBridgeStateStore(root).load();
    expect(snapshot.runs.map((r) => r.accepted.execution_id)).toEqual(["exec_new", "exec_legacy"]);
    expect(snapshot.runs.map((r) => r.acceptedAt)).toEqual(["2026-08-01T08:59:59.500Z", undefined]);
  });
});
