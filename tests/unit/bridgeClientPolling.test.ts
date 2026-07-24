import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskViaBridge } from "../../src/hermes/bridgeClient.js";

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
});
