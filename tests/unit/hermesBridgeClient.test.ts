import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";
import { HermesBridgeClient } from "../../src/hermes/bridgeClient.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("HermesBridgeClient", () => {
  it("reports bridge unavailability without throwing", async () => {
    const client = new HermesBridgeClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 50,
    });

    const health = await client.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it("returns a timeout-shaped failure when fetch exceeds timeout", async () => {
    const client = new HermesBridgeClient({
      baseUrl: "http://bridge.invalid",
      timeoutMs: 10,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
        });
        throw new Error("unreachable");
      },
    });

    const health = await client.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.reason ?? "").toMatch(/timeout|abort/i);
  });

  it("creates sessions, executes tasks, and waits for structured results", async () => {
    const workdir = await makeTempDir("pi-hermes-client-work-");
    const outputDir = await makeTempDir("pi-hermes-client-out-");
    const stateRoot = await makeTempDir("pi-hermes-client-state-");

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
    const client = new HermesBridgeClient({
      baseUrl: `http://${listening.host}:${listening.port}`,
      timeoutMs: 5_000,
    });

    try {
      const session = await client.createSession({ workdir });
      const accepted = await client.executeTask({
        request_id: "req_bridge_client",
        session_id: session.session_id,
        objective: "Write a report to the output dir and summarize it.",
        workdir,
        allowed_tools: ["bash"],
        allowed_actions: ["read", "write"],
        timeout_seconds: 20,
        output_dir: outputDir,
        metadata: {
          mission_id: "mission-bridge-client",
          run_id: "run-bridge-client",
          step_id: "step-bridge-client",
        },
      });

      const run = await client.waitForTerminalRun(accepted.execution_id, { timeoutMs: 10_000, pollIntervalMs: 50 });
      const events = await client.getEvents(accepted.execution_id);

      expect(accepted.status).toBe("accepted");
      expect(run.status).toBe("completed");
      expect(run.worker_result?.summary ?? run.result?.summary).toContain("Fake Hermes completed successfully");
      expect(events.items.some((event) => event.type === "task.completed")).toBe(true);
    } finally {
      await server.stop();
    }
  }, 15_000);
});
