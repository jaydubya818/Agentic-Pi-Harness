import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __bridgeClientTestables, runTaskViaBridge } from "../../src/hermes/bridgeClient.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bridge client run polling", () => {
  it("keeps polling through a flaky non-JSON /runs response instead of aborting", async () => {
    let polls = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/execute") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "accepted" }));
        return;
      }
      if (req.url?.startsWith("/runs/exec_1/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.url?.startsWith("/runs/exec_1")) {
        polls += 1;
        if (polls === 1) {
          // Transient proxy-style failure: non-2xx with a non-JSON body.
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("bad gateway");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "completed", worker_result: { status: "completed" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    try {
      const run = await runTaskViaBridge({
        objective: "poll resilience",
        workdir: outRoot,
        outRoot,
        timeoutSeconds: 5,
        bridgeUrl: `http://127.0.0.1:${port}`,
      });
      expect(run.result.status).toBe("completed");
      expect(polls).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("settles a terminal errored run with no result payload instead of polling until the deadline", async () => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/execute") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "accepted" }));
        return;
      }
      if (req.url?.startsWith("/runs/exec_1/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.url?.startsWith("/runs/exec_1")) {
        // Spawn-failure shape: terminal, error recorded, no result payload.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "failed", error: "hermes spawn failed", worker_result: null, result: null }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    const startedAt = Date.now();
    try {
      await expect(runTaskViaBridge({
        objective: "terminal error settlement",
        workdir: outRoot,
        outRoot,
        // High timeout: before the fix the client polled this out in full
        // before failing; the test would blow its own timeout below.
        timeoutSeconds: 600,
        bridgeUrl: `http://127.0.0.1:${port}`,
      })).rejects.toThrow(/status failed: hermes spawn failed/);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
  it("best-effort cancels the execution when the poll deadline expires without a result", async () => {
    let cancelled = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/execute") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "accepted" }));
        return;
      }
      if (req.method === "POST" && req.url === "/cancel") {
        cancelled += 1;
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "cancelled" }));
        return;
      }
      if (req.url?.startsWith("/runs/exec_1/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.url?.startsWith("/runs/exec_1")) {
        // Never terminal: the worker just keeps running past the deadline.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "running" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    const previousGraceMs = __bridgeClientTestables.pollSettings.deadlineGraceMs;
    const previousSettleMs = __bridgeClientTestables.pollSettings.cancelSettleMs;
    __bridgeClientTestables.pollSettings.deadlineGraceMs = 200;
    __bridgeClientTestables.pollSettings.cancelSettleMs = 300;
    try {
      await expect(runTaskViaBridge({
        objective: "deadline expiry cancel",
        workdir: outRoot,
        outRoot,
        timeoutSeconds: 1,
        bridgeUrl: `http://127.0.0.1:${port}`,
      })).rejects.toThrow(/did not produce a result/);
      expect(cancelled).toBe(1);
    } finally {
      __bridgeClientTestables.pollSettings.deadlineGraceMs = previousGraceMs;
      __bridgeClientTestables.pollSettings.cancelSettleMs = previousSettleMs;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("waits for the deadline-expiry cancel to settle so the session close does not race the run", async () => {
    let cancelled = 0;
    let closedWhileRunning = 0;
    let closed = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/sessions/sess_1/close") {
        // A real bridge answers 409 while the execution is non-terminal.
        if (cancelled === 0) {
          closedWhileRunning += 1;
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "session has a non-terminal execution" }));
          return;
        }
        closed += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1", status: "closed" }));
        return;
      }
      if (req.method === "POST" && req.url === "/execute") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "accepted" }));
        return;
      }
      if (req.method === "POST" && req.url === "/cancel") {
        cancelled += 1;
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "cancelled" }));
        return;
      }
      if (req.url?.startsWith("/runs/exec_1/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.url?.startsWith("/runs/exec_1")) {
        if (cancelled === 0) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "running" }));
          return;
        }
        // After the cancel the run settles terminal with a result payload.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "cancelled", worker_result: { status: "cancelled" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    const previousGraceMs = __bridgeClientTestables.pollSettings.deadlineGraceMs;
    __bridgeClientTestables.pollSettings.deadlineGraceMs = 200;
    try {
      const run = await runTaskViaBridge({
        objective: "deadline expiry cancel settles",
        workdir: outRoot,
        outRoot,
        timeoutSeconds: 1,
        bridgeUrl: `http://127.0.0.1:${port}`,
      });
      expect(cancelled).toBe(1);
      // The settled cancelled run is returned like any other terminal run.
      expect(run.result.status).toBe("cancelled");
      // The session close landed after the run settled, not against a
      // still-running execution (which a real bridge rejects with 409).
      expect(closedWhileRunning).toBe(0);
      expect(closed).toBe(1);
    } finally {
      __bridgeClientTestables.pollSettings.deadlineGraceMs = previousGraceMs;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("aborts a hung session-create request instead of stalling on the undici default", async () => {
    // POST /sessions and POST /execute ran with no abort signal at all, so a
    // bridge that accepts the connection and never answers parked the whole
    // governed run on undici's ~300s header timeout before polling started.
    const hungResponses: import("node:http").ServerResponse[] = [];
    const server = createServer((_req, res) => {
      hungResponses.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    const settings = __bridgeClientTestables.pollSettings;
    const previous = { ...settings };
    settings.setupRequestTimeoutMs = 250;
    const startedAt = Date.now();
    try {
      await expect(runTaskViaBridge({
        objective: "hung bridge session create",
        workdir: outRoot,
        outRoot,
        timeoutSeconds: 600,
        bridgeUrl: `http://127.0.0.1:${port}`,
      })).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      Object.assign(settings, previous);
      for (const res of hungResponses) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("aborts a hung poll request instead of stalling past the run deadline", async () => {
    // The bridge accepts /runs connections and never answers: without a
    // per-request abort timeout each poll parks on undici's ~300s default
    // and the deadline the loop exists to enforce is never rechecked.
    const hungResponses: import("node:http").ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "sess_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/execute") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "accepted" }));
        return;
      }
      if (req.method === "POST" && req.url === "/cancel") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ execution_id: "exec_1", status: "cancelled" }));
        return;
      }
      // Everything else (including every /runs poll) hangs forever.
      hungResponses.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const outRoot = await mkdtemp(join(tmpdir(), "pi-bridge-poll-"));
    createdPaths.push(outRoot);

    const settings = __bridgeClientTestables.pollSettings;
    const previous = { ...settings };
    settings.deadlineGraceMs = 200;
    settings.cancelSettleMs = 300;
    settings.requestTimeoutMs = 250;
    const startedAt = Date.now();
    try {
      await expect(runTaskViaBridge({
        objective: "hung bridge poll",
        workdir: outRoot,
        outRoot,
        timeoutSeconds: 1,
        bridgeUrl: `http://127.0.0.1:${port}`,
      })).rejects.toThrow(/did not produce a result/);
      expect(Date.now() - startedAt).toBeLessThan(8000);
    } finally {
      Object.assign(settings, previous);
      for (const res of hungResponses) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
