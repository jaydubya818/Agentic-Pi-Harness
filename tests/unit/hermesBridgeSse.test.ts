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

describe("HermesBridgeServer SSE", () => {
  it("replays persisted history after restart and closes on terminal runs", async () => {
    const workdir = await makeTempDir("pi-hermes-sse-work-");
    const outputDir = await makeTempDir("pi-hermes-sse-out-");
    const stateRoot = await makeTempDir("pi-hermes-sse-state-");

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
          request_id: "req_sse_persist",
          session_id: session.session_id,
          objective: "Write a report to the output dir and summarize it.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read", "write"],
          timeout_seconds: 20,
          output_dir: outputDir,
          metadata: { mission_id: "m", run_id: "r", step_id: "s" },
        }),
      });
      const accepted = await executeResponse.json() as { execution_id: string };
      executionId = accepted.execution_id;

      for (let i = 0; i < 60; i++) {
        const runResponse = await fetch(`${firstBase}/runs/${executionId}`);
        const run = await runResponse.json() as { status: string };
        if (run.status === "completed") break;
        await sleep(50);
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
      const events = await collectSse(`${secondBase}/runs/${executionId}/events?stream=1`);
      expect(events.some((event) => event.event === "task.started")).toBe(true);
      expect(events.some((event) => event.event === "task.completed")).toBe(true);
      const ids = events.map((event) => event.id).filter((id): id is number => typeof id === "number");
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
    } finally {
      await secondServer.stop();
    }
  }, 20000);

  it("streams live tail after replay and supports Last-Event-ID reconnect", async () => {
    const workdir = await makeTempDir("pi-hermes-sse-live-work-");
    const outputDir = await makeTempDir("pi-hermes-sse-live-out-");
    const stateRoot = await makeTempDir("pi-hermes-sse-live-state-");

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
      const session = await sessionResponse.json() as { session_id: string };
      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "req_sse_live",
          session_id: session.session_id,
          objective: "__SLOW__ keep working until interrupted.",
          workdir,
          allowed_tools: ["bash"],
          allowed_actions: ["read"],
          timeout_seconds: 30,
          output_dir: outputDir,
          metadata: { mission_id: "m", run_id: "r", step_id: "s" },
        }),
      });
      const accepted = await executeResponse.json() as { execution_id: string };

      const firstPass = await collectSse(`${base}/runs/${accepted.execution_id}/events/stream`, async (event, seen) => {
        if (event.event === "task.output" && String(event.data?.data?.line ?? "").includes("starting slow fake task")) {
          await fetch(`${base}/interrupt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ execution_id: accepted.execution_id }),
          });
        }
        return seen.some((entry) => entry.event === "task.interrupted");
      });

      expect(firstPass.some((event) => event.event === "task.output")).toBe(true);
      expect(firstPass.some((event) => event.event === "task.interrupted")).toBe(true);

      const reconnectFrom = firstPass.find((event) => event.event === "task.progress")?.id ?? 1;
      const resumed = await collectSse(`${base}/runs/${accepted.execution_id}/events?stream=1`, undefined, {
        "Last-Event-ID": String(reconnectFrom),
      });
      expect(resumed.every((event) => (event.id ?? 0) > reconnectFrom)).toBe(true);
      expect(resumed.some((event) => event.event === "task.interrupted")).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);
});

interface SseMessage {
  id?: number;
  event: string;
  data: any;
}

async function collectSse(
  url: string,
  stopWhen?: (event: SseMessage, seen: SseMessage[]) => Promise<boolean> | boolean,
  headers: Record<string, string> = {},
): Promise<SseMessage[]> {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: SseMessage[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const idx = buffer.indexOf("\n\n");
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseChunk(chunk);
      if (!parsed || parsed.event === "heartbeat") continue;
      messages.push(parsed);
      if (stopWhen && await stopWhen(parsed, messages)) {
        await reader.cancel();
        return messages;
      }
    }
  }

  return messages;
}

function parseSseChunk(chunk: string): SseMessage | null {
  const lines = chunk.split("\n");
  let id: number | undefined;
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("id: ")) id = Number.parseInt(line.slice(4), 10);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }

  if (dataLines.length === 0) return null;
  return {
    id,
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
