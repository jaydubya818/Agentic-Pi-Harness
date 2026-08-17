import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";
import { HermesBridgeStateStore } from "../../src/hermes/bridgeState.js";
import { runTaskViaBridge } from "../../src/hermes/bridgeClient.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("HermesBridgeServer", () => {
  it("joins concurrent stop() calls instead of re-closing the server", async () => {
    const stateRoot = await makeTempDir("pi-hermes-bridge-stop-state-");
    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });
    await server.start();
    // A second SIGINT-style stop while the first is draining must join the
    // in-flight stop, not reject with ERR_SERVER_NOT_RUNNING.
    await Promise.all([server.stop(), server.stop()]);
    await server.stop();
  });

  it("requires bearer auth when bridge token configured", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-auth-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-auth-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-auth-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "bridge-secret",
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const healthResponse = await fetch(`${base}/healthz`);
      expect(healthResponse.status).toBe(200);

      const unauthorizedSession = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      expect(unauthorizedSession.status).toBe(401);

      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bridge-secret",
        },
        body: JSON.stringify({ workdir }),
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bridge-secret",
        },
        body: JSON.stringify({
          request_id: "req_bridge_auth",
          session_id: session.session_id,
          objective: "Write a report to the output dir and summarize it.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read", "write"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: {
            mission_id: "mission-bridge-auth",
            run_id: "run-bridge-auth",
            step_id: "step-bridge-auth",
          },
        }),
      });
      expect(executeResponse.status).toBe(202);
      const accepted = await executeResponse.json() as { execution_id: string };

      let status = "accepted";
      for (let i = 0; i < 40; i++) {
        const runResponse = await fetch(`${base}/runs/${accepted.execution_id}`, {
          headers: { authorization: "Bearer bridge-secret" },
        });
        expect(runResponse.status).toBe(200);
        const run = await runResponse.json() as { status: string; run_kind: string; lifecycle: { bridge_status: string } };
        expect(run.run_kind).toBe("legacy");
        expect(run.lifecycle.bridge_status).toBe(run.status);
        status = run.status;
        if (status === "completed") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }

      expect(status).toBe("completed");
    } finally {
      await server.stop();
    }
  }, 15000);

  it("refuses to start unauthenticated on a non-loopback host", async () => {
    const stateRoot = await makeTempDir("pi-hermes-bridge-nonloopback-state-");

    const unauthenticated = new HermesBridgeServer({
      host: "0.0.0.0",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
    });
    await expect(unauthenticated.start()).rejects.toThrow(/non-loopback host/);

    // Loopback spellings stay allowed without a token.
    for (const host of ["127.0.0.1", "localhost"]) {
      const local = new HermesBridgeServer({ host, port: 0, stateRoot, enforceKnowledgePolicy: false });
      const listening = await local.start();
      expect(listening.port).toBeGreaterThan(0);
      await local.stop();
    }

    // A configured auth token unlocks non-loopback binds.
    const authed = new HermesBridgeServer({
      host: "0.0.0.0",
      port: 0,
      stateRoot,
      authToken: "bridge-secret",
      enforceKnowledgePolicy: false,
    });
    const listening = await authed.start();
    expect(listening.port).toBeGreaterThan(0);
    await authed.stop();
  });

  it("rejects malformed and oversized JSON bodies without a 500", async () => {
    const stateRoot = await makeTempDir("pi-hermes-bridge-badbody-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const malformed = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(malformed.status).toBe(400);
      const malformedBody = await malformed.json() as { error: string };
      expect(malformedBody.error).toMatch(/invalid JSON body/);

      const oversized = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"pad":"${"x".repeat(4 * 1024 * 1024 + 16)}"}`,
      });
      expect(oversized.status).toBe(413);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("rejects path-traversal execution ids before they reach bridge state", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-trav-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-trav-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-trav-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      enforceKnowledgePolicy: false,
      stateRoot: join(stateRoot, "bridge"),
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot: join(stateRoot, "adapter"),
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_bridge_traversal",
          session_id: session.session_id,
          execution_id: "../../escaped-run",
          objective: "Attempt to escape the bridge state root.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: {
            mission_id: "mission-bridge-traversal",
            run_id: "run-bridge-traversal",
            step_id: "step-1",
          },
        }),
      });
      expect(executeResponse.status).toBe(400);
      const body = await executeResponse.json() as { error: string };
      expect(body.error).toMatch(/not a safe path segment/);

      const denials = await (await fetch(`${base}/preflight-denials`)).json() as Array<{ code: string }>;
      expect(denials.some((denial) => denial.code === "legacy_preflight_denied")).toBe(true);

      // A second denial gives ?limit something to tail past.
      const secondDenial = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_bridge_traversal_2",
          session_id: session.session_id,
          execution_id: "../../escaped-run-2",
          objective: "Attempt to escape the bridge state root again.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: {
            mission_id: "mission-bridge-traversal",
            run_id: "run-bridge-traversal-2",
            step_id: "step-1",
          },
        }),
      });
      expect(secondDenial.status).toBe(400);

      const tailed = await (await fetch(`${base}/preflight-denials?limit=1`)).json() as Array<{ request_id?: string }>;
      expect(tailed).toHaveLength(1);
      expect(tailed[0].request_id).toBe("req_bridge_traversal_2");

      const badLimit = await fetch(`${base}/preflight-denials?limit=0x10`);
      expect(badLimit.status).toBe(400);
      const zeroLimit = await fetch(`${base}/preflight-denials?limit=0`);
      expect(zeroLimit.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("addresses runs whose execution id needs percent-encoding", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-enc-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-enc-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-enc-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;
    try {
      const session = await (await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      })).json() as { session_id: string };

      // A space is not a path separator, so assertSafeStateIdSegment accepts
      // it -- but a client must percent-encode it in the URL.
      const executionId = "exec bridge encoded";
      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_bridge_encoded",
          session_id: session.session_id,
          execution_id: executionId,
          objective: "Write a report to the output dir and summarize it.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read", "write"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: { mission_id: "m", run_id: "r", step_id: "s" },
        }),
      });
      expect(executeResponse.status).toBe(202);

      const encoded = encodeURIComponent(executionId);
      const runResponse = await fetch(`${base}/runs/${encoded}`);
      expect(runResponse.status).toBe(200);
      expect((await runResponse.json() as { execution_id: string }).execution_id).toBe(executionId);

      const eventsResponse = await fetch(`${base}/runs/${encoded}/events`);
      expect(eventsResponse.status).toBe(200);
      expect((await eventsResponse.json() as { execution_id: string }).execution_id).toBe(executionId);

      // A genuinely unknown id still 404s, and malformed percent-encoding
      // must not throw a 500 out of the router.
      expect((await fetch(`${base}/runs/nope`)).status).toBe(404);
      expect((await fetch(`${base}/runs/%zz`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  }, 30000);

  it("starts sessions and executes Hermes runs over HTTP", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_bridge_1",
          session_id: session.session_id,
          objective: "Write a report to the output dir and summarize it.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read", "write"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: {
            mission_id: "mission-bridge",
            run_id: "run-bridge",
            step_id: "step-bridge",
          },
        }),
      });
      expect(executeResponse.status).toBe(202);
      const accepted = await executeResponse.json() as { execution_id: string };

      let status = "accepted";
      for (let i = 0; i < 40; i++) {
        const runResponse = await fetch(`${base}/runs/${accepted.execution_id}`);
        expect(runResponse.status).toBe(200);
        const run = await runResponse.json() as { status: string; run_kind: string; result?: { summary: string }; worker_result?: { summary: string } };
        expect(run.run_kind).toBe("legacy");
        status = run.status;
        if (status === "completed" && run.worker_result?.summary) {
          expect(run.result?.summary).toContain("Fake Hermes completed successfully");
          expect(run.worker_result.summary).toContain("Fake Hermes completed successfully");
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }

      expect(status).toBe("completed");

      const eventsResponse = await fetch(`${base}/runs/${accepted.execution_id}/events`);
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json() as { event_format: string; items: Array<{ type: string }> };
      expect(events.event_format).toBe("legacy");
      expect(events.items.some((event) => event.type === "task.started")).toBe(true);
      expect(events.items.some((event) => event.type === "task.completed")).toBe(true);

      const rawEventsResponse = await fetch(`${base}/runs/${accepted.execution_id}/events?view=raw`);
      expect(rawEventsResponse.status).toBe(200);
      const rawEvents = await rawEventsResponse.json() as Array<{ type: string }>;
      expect(rawEvents.some((event) => event.type === "task.started")).toBe(true);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("lists open sessions on GET /sessions with tail limiting", async () => {
    const workdirA = await makeTempDir("pi-hermes-bridge-sessions-a-");
    const workdirB = await makeTempDir("pi-hermes-bridge-sessions-b-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-sessions-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      expect(await (await fetch(`${base}/sessions`)).json()).toEqual({ count: 0, items: [] });

      const open = async (workdir: string) => {
        const response = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workdir }),
        });
        expect(response.status).toBe(200);
        return (await response.json() as { session_id: string }).session_id;
      };

      const first = await open(workdirA);
      const second = await open(workdirB);

      const listResponse = await fetch(`${base}/sessions`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as { count: number; items: Array<{ session_id: string; status: string }> };
      expect(list.count).toBe(2);
      expect(list.items.map((item) => item.session_id)).toEqual([first, second]);
      expect(list.items.every((item) => item.status === "idle")).toBe(true);

      const tail = await (await fetch(`${base}/sessions?limit=1`)).json() as { count: number; items: Array<{ session_id: string }> };
      expect(tail.count).toBe(2);
      expect(tail.items.map((item) => item.session_id)).toEqual([second]);

      const badLimit = await fetch(`${base}/sessions?limit=0`);
      expect(badLimit.status).toBe(400);

      // A closed session leaves the listing, which is the whole point of
      // being able to see what the bridge is still holding.
      const closeResponse = await fetch(`${base}/sessions/${first}/close`, { method: "POST" });
      expect(closeResponse.status).toBe(200);
      const afterClose = await (await fetch(`${base}/sessions`)).json() as { count: number; items: Array<{ session_id: string }> };
      expect(afterClose.items.map((item) => item.session_id)).toEqual([second]);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("lists run summaries on GET /runs with tail limiting", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-list-work-");
    const outputDirA = await makeTempDir("pi-hermes-bridge-list-out-a-");
    const outputDirB = await makeTempDir("pi-hermes-bridge-list-out-b-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-list-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const emptyResponse = await fetch(`${base}/runs`);
      expect(emptyResponse.status).toBe(200);
      expect(await emptyResponse.json()).toEqual({ count: 0, items: [] });

      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      const session = await sessionResponse.json() as { session_id: string };

      const execute = async (requestId: string, outputDir: string) => {
        const executeResponse = await fetch(`${base}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            session_id: session.session_id,
            objective: "Write a report to the output dir and summarize it.",
            workdir,
            allowed_tools: ["bash"],
            allowed_actions: ["read", "write"],
            timeout_seconds: 20,
            output_dir: outputDir,
            metadata: { mission_id: "mission-list", run_id: "run-list", step_id: requestId },
          }),
        });
        expect(executeResponse.status).toBe(202);
        const accepted = await executeResponse.json() as { execution_id: string };
        for (let i = 0; i < 40; i++) {
          const runResponse = await fetch(`${base}/runs/${accepted.execution_id}`);
          const run = await runResponse.json() as { status: string };
          if (run.status === "completed") return accepted.execution_id;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        throw new Error(`run ${accepted.execution_id} did not complete`);
      };

      // One session allows one execution at a time; run them sequentially.
      const first = await execute("req_list_1", outputDirA);
      const second = await execute("req_list_2", outputDirB);

      const listResponse = await fetch(`${base}/runs`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as { count: number; items: Array<Record<string, unknown>> };
      expect(list.count).toBe(2);
      expect(list.items.map((item) => item.execution_id)).toEqual([first, second]);
      const summary = list.items[0];
      expect(summary.run_kind).toBe("legacy");
      expect(summary.status).toBe("completed");
      expect(summary.terminal).toBe(true);
      expect(summary.mission_id).toBe("mission-list");
      expect(summary.links).toEqual({ run: `/runs/${first}`, events: `/runs/${first}/events` });
      // Summaries stay light: no event bodies or task envelopes inline.
      expect(summary.events).toBeUndefined();
      expect(summary.task_envelope).toBeUndefined();

      // ?limit=N tails the most recently accepted runs.
      const tailResponse = await fetch(`${base}/runs?limit=1`);
      const tail = await tailResponse.json() as { count: number; items: Array<Record<string, unknown>> };
      expect(tail.count).toBe(2);
      expect(tail.items.map((item) => item.execution_id)).toEqual([second]);

      const badLimit = await fetch(`${base}/runs?limit=0`);
      expect(badLimit.status).toBe(400);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("cancels the accepted worker and answers 500 when bridge bookkeeping fails post-accept", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-postaccept-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-postaccept-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-postaccept-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    // Sabotage the first post-accept persist: the worker has already been
    // spawned by the adapter when persistRun runs.
    const internals = server as unknown as { stateStore: { persistRun: (record: unknown) => Promise<void> } };
    const originalPersistRun = internals.stateStore.persistRun.bind(internals.stateStore);
    let failNextPersist = true;
    internals.stateStore.persistRun = async (record: unknown) => {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error("disk full (injected)");
      }
      return originalPersistRun(record);
    };

    try {
      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      const session = await sessionResponse.json() as { session_id: string };

      const makeBody = (requestId: string) => JSON.stringify({
        request_id: requestId,
        session_id: session.session_id,
        objective: "Write a report to the output dir and summarize it.",
        workdir,
        allowed_tools: ["bash"],
        allowed_actions: ["read", "write"],
        timeout_seconds: 20,
        output_dir: outputDir,
        metadata: { mission_id: "mission-postaccept", run_id: "run-postaccept", step_id: "step-1" },
      });

      const failedExecute = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: makeBody("req_postaccept_1"),
      });
      // A post-accept bookkeeping failure is a bridge error, not a
      // preflight denial: the worker was already accepted and spawned.
      expect(failedExecute.status).toBe(500);
      const failedBody = await failedExecute.json() as { error: string };
      expect(failedBody.error).toContain("disk full (injected)");

      const denials = await (await fetch(`${base}/preflight-denials`)).json() as unknown[];
      expect(denials).toEqual([]);

      // The phantom run record is dropped rather than wedging the bridge.
      const list = await (await fetch(`${base}/runs`)).json() as { count: number };
      expect(list.count).toBe(0);

      // The session is released (worker cancelled), so a follow-up execute
      // on the same session is accepted and completes.
      let accepted: { execution_id: string } | null = null;
      for (let i = 0; i < 40 && !accepted; i++) {
        const retryExecute = await fetch(`${base}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: makeBody("req_postaccept_2"),
        });
        if (retryExecute.status === 202) {
          accepted = await retryExecute.json() as { execution_id: string };
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      expect(accepted).not.toBeNull();

      let status = "accepted";
      for (let i = 0; i < 40; i++) {
        const run = await (await fetch(`${base}/runs/${accepted!.execution_id}`)).json() as { status: string };
        status = run.status;
        if (status === "completed") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      expect(status).toBe("completed");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("reloads persisted sessions, runs, and event logs after restart", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-persist-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-persist-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-persist-state-");

    const firstServer = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const firstListening = await firstServer.start();
    const firstBase = `http://${firstListening.host}:${firstListening.port}`;
    let executionId = "";
    try {
      const sessionResponse = await fetch(`${firstBase}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await fetch(`${firstBase}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_bridge_persist",
          session_id: session.session_id,
          objective: "Write a report to the output dir and summarize it.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read", "write"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: {
            mission_id: "mission-bridge-persist",
            run_id: "run-bridge-persist",
            step_id: "step-bridge-persist",
          },
        }),
      });
      const accepted = await executeResponse.json() as { execution_id: string };
      executionId = accepted.execution_id;

      for (let i = 0; i < 40; i++) {
        const runResponse = await fetch(`${firstBase}/runs/${executionId}`);
        const run = await runResponse.json() as { status: string };
        if (run.status === "completed") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    } finally {
      await firstServer.stop();
    }

    const secondServer = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const secondListening = await secondServer.start();
    const secondBase = `http://${secondListening.host}:${secondListening.port}`;
    try {
      const runResponse = await fetch(`${secondBase}/runs/${executionId}`);
      expect(runResponse.status).toBe(200);
      const run = await runResponse.json() as { status: string; run_kind: string; worker_result?: { summary: string } };
      expect(run.status).toBe("completed");
      expect(run.run_kind).toBe("legacy");
      expect(run.worker_result?.summary).toContain("Fake Hermes completed successfully");

      const eventsResponse = await fetch(`${secondBase}/runs/${executionId}/events`);
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json() as { event_format: string; items: Array<{ type: string }> };
      expect(events.event_format).toBe("legacy");
      expect(events.items.some((event) => event.type === "task.started")).toBe(true);
      expect(events.items.some((event) => event.type === "task.completed")).toBe(true);

      // Restored runs are enumerable via the listing endpoint too.
      const listResponse = await fetch(`${secondBase}/runs`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as { count: number; items: Array<{ execution_id: string; terminal: boolean }> };
      expect(list.count).toBe(1);
      expect(list.items[0].execution_id).toBe(executionId);
      expect(list.items[0].terminal).toBe(true);
    } finally {
      await secondServer.stop();
    }
  }, 15000);

  it("fails fast with a clear error when session creation is unauthorized", async () => {
    const stateRoot = await makeTempDir("pi-hermes-bridge-auth-state-");
    const workdir = await makeTempDir("pi-hermes-bridge-auth-work-");
    const outRoot = await makeTempDir("pi-hermes-bridge-auth-out-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      authToken: "expected-token",
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });
    const listening = await server.start();

    try {
      await expect(runTaskViaBridge({
        objective: "should never start",
        workdir,
        outRoot,
        timeoutSeconds: 5,
        bridgeUrl: `http://${listening.host}:${listening.port}`,
        bridgeToken: "wrong-token",
      })).rejects.toThrow(/bridge session create failed: HTTP 401/);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("rejects malformed control-endpoint bodies with 400", async () => {
    const stateRoot = await makeTempDir("pi-hermes-bridge-badbody-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    try {
      const missingWorkdir = await post("/sessions", {});
      expect(missingWorkdir.status).toBe(400);
      expect(((await missingWorkdir.json()) as { error: string }).error).toContain("workdir");

      const emptyWorkdir = await post("/sessions", { workdir: "" });
      expect(emptyWorkdir.status).toBe(400);

      const missingExecutionId = await post("/interrupt", {});
      expect(missingExecutionId.status).toBe(400);
      expect(((await missingExecutionId.json()) as { error: string }).error).toContain("execution_id");

      const numericExecutionId = await post("/cancel", { execution_id: 123 });
      expect(numericExecutionId.status).toBe(400);

      const stringEnv = await post("/sessions", { workdir: "/tmp", env: "PATH=/evil" });
      expect(stringEnv.status).toBe(400);
      expect(((await stringEnv.json()) as { error: string }).error).toContain("env");

      const arrayEnv = await post("/sessions", { workdir: "/tmp", env: ["PATH=/evil"] });
      expect(arrayEnv.status).toBe(400);

      const nonStringEnvValue = await post("/sessions", { workdir: "/tmp", env: { DEBUG: 1 } });
      expect(nonStringEnvValue.status).toBe(400);

      const numericProfile = await post("/sessions", { workdir: "/tmp", profile: 7 });
      expect(numericProfile.status).toBe(400);
      expect(((await numericProfile.json()) as { error: string }).error).toContain("profile");
    } finally {
      await server.stop();
    }
  }, 15000);

  it("refuses to cancel or interrupt a run that is already terminal", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-term-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-term-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-term-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    try {
      const sessionResponse = await post("/sessions", { workdir });
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await post("/execute", {
        request_id: "req_bridge_terminal_guard",
        session_id: session.session_id,
        objective: "Write a report to the output dir and summarize it.",
        workdir,
        allowed_tools: ["bash"],
        allowed_actions: ["read", "write"],
        timeout_seconds: 20,
        output_dir: outputDir,
        metadata: {
          mission_id: "mission-terminal-guard",
          run_id: "run-terminal-guard",
          step_id: "step-terminal-guard",
        },
      });
      expect(executeResponse.status).toBe(202);
      const accepted = await executeResponse.json() as { execution_id: string };

      let status = "accepted";
      for (let i = 0; i < 60; i++) {
        const runResponse = await fetch(`${base}/runs/${accepted.execution_id}`);
        status = ((await runResponse.json()) as { status: string }).status;
        if (status === "completed") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      expect(status).toBe("completed");

      // Cancelling a finished run must not signal whatever execution is
      // active on the session now.
      const cancelResponse = await post("/cancel", { execution_id: accepted.execution_id });
      expect(cancelResponse.status).toBe(409);
      expect(((await cancelResponse.json()) as { error: string }).error).toContain("terminal");

      const interruptResponse = await post("/interrupt", { execution_id: accepted.execution_id });
      expect(interruptResponse.status).toBe(409);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("stop() cancels in-flight executions instead of waiting out their timeout budget", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-stop-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-stop-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-stop-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const sessionResponse = await post("/sessions", { workdir });
    const session = await sessionResponse.json() as { session_id: string };
    const executeResponse = await post("/execute", {
      request_id: "req_bridge_stop_cancel",
      session_id: session.session_id,
      objective: "__SLOW__ keep working until the bridge shuts down.",
      workdir,
      allowed_tools: ["bash"],
      allowed_actions: ["read"],
      timeout_seconds: 600,
      output_dir: outputDir,
      metadata: {
        mission_id: "mission-stop-cancel",
        run_id: "run-stop-cancel",
        step_id: "step-stop-cancel",
      },
    });
    expect(executeResponse.status).toBe(202);
    const accepted = await executeResponse.json() as { execution_id: string };

    // Let the worker actually start streaming.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

    const stopStarted = Date.now();
    await server.stop();
    expect(Date.now() - stopStarted).toBeLessThan(10000);

    const run = server.getRun(accepted.execution_id);
    expect(run?.status).toBe("cancelled");
  }, 15000);

  it("closes sessions via POST /sessions/:id/close once their runs are terminal", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-close-work-");
    const outputDir = await makeTempDir("pi-hermes-bridge-close-out-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-close-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;
    const post = (path: string, body?: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    try {
      const unknownClose = await post("/sessions/sess_missing/close");
      expect(unknownClose.status).toBe(404);

      const sessionResponse = await post("/sessions", { workdir });
      const session = await sessionResponse.json() as { session_id: string };

      const executeResponse = await post("/execute", {
        request_id: "req_bridge_close",
        session_id: session.session_id,
        objective: "__SLOW__ keep working until cancelled.",
        workdir,
        allowed_tools: ["bash"],
        allowed_actions: ["read"],
        timeout_seconds: 600,
        output_dir: outputDir,
        metadata: { mission_id: "mission-close", run_id: "run-close", step_id: "step-close" },
      });
      expect(executeResponse.status).toBe(202);
      const accepted = await executeResponse.json() as { execution_id: string };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

      const closeWhileRunning = await post(`/sessions/${session.session_id}/close`);
      expect(closeWhileRunning.status).toBe(409);

      const cancelResponse = await post("/cancel", { execution_id: accepted.execution_id });
      expect(cancelResponse.status).toBe(202);
      let terminal = false;
      for (let i = 0; i < 60 && !terminal; i++) {
        const runResponse = await fetch(`${base}/runs/${accepted.execution_id}`);
        const run = await runResponse.json() as { status: string };
        terminal = ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
        if (!terminal) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      expect(terminal).toBe(true);

      const closeResponse = await post(`/sessions/${session.session_id}/close`);
      expect(closeResponse.status).toBe(200);
      expect(await closeResponse.json()).toEqual({ session_id: session.session_id, status: "closed" });

      const closeAgain = await post(`/sessions/${session.session_id}/close`);
      expect(closeAgain.status).toBe(404);
    } finally {
      await server.stop();
    }
  }, 15000);

  it("marks runs restored from disk as failed instead of running forever", async () => {
    const workdir = await makeTempDir("pi-hermes-bridge-restore-work-");
    const stateRoot = await makeTempDir("pi-hermes-bridge-restore-state-");

    // Persist a non-terminal run as if a previous bridge process died mid-run.
    const store = new HermesBridgeStateStore(stateRoot);
    await store.init();
    await store.persistRun({
      accepted: {
        request_id: "req_orphan",
        session_id: "sess_orphan",
        execution_id: "exec_orphan",
        status: "accepted",
      },
      request: {
        request_id: "req_orphan",
        session_id: "sess_orphan",
        objective: "orphaned by crash",
        workdir,
        allowed_tools: [],
        allowed_actions: [],
        timeout_seconds: 60,
        output_dir: workdir,
        metadata: {},
      },
      status: "running",
      session: {
        session_id: "sess_orphan",
        workdir,
        profile: null,
        runtime_dir: workdir,
        hermes_session_id: null,
        status: "running",
        created_at: new Date().toISOString(),
      },
      events: [],
      result: null,
      error: null,
    });

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const runResponse = await fetch(`${base}/runs/exec_orphan`);
      expect(runResponse.status).toBe(200);
      const run = await runResponse.json() as { status: string; error: string | null };
      expect(run.status).toBe("failed");
      expect(run.error).toContain("bridge restarted");

      // And it stays terminal across another restart.
      await server.stop();
      const secondServer = new HermesBridgeServer({
        host: "127.0.0.1",
        port: 0,
        stateRoot,
        enforceKnowledgePolicy: false,
      });
      const secondListening = await secondServer.start();
      try {
        const persisted = await fetch(`http://${secondListening.host}:${secondListening.port}/runs/exec_orphan`);
        const persistedRun = await persisted.json() as { status: string };
        expect(persistedRun.status).toBe("failed");
      } finally {
        await secondServer.stop();
      }
    } finally {
      await server.stop();
    }
  }, 15000);

});
