import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";

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
    } finally {
      await secondServer.stop();
    }
  }, 15000);
});
