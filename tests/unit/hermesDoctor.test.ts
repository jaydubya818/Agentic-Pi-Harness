import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesDoctor } from "../../src/cli/hermes-doctor.js";
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

describe("runHermesDoctor", () => {
  it("validates an authenticated bridge and smoke-tests execute", async () => {
    const workdir = await makeTempDir("pi-hermes-doctor-work-");
    const stateRoot = await makeTempDir("pi-hermes-doctor-state-");

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "doctor-secret",
      enforceKnowledgePolicy: false,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "pty",
        stateRoot,
      },
    });

    const listening = await server.start();
    try {
      const checks = await runHermesDoctor({
        url: `http://${listening.host}:${listening.port}`,
        token: "doctor-secret",
        workdir,
        timeoutMs: 15000,
      });
      expect(checks.every((check) => check.ok)).toBe(true);
      expect(checks.find((check) => check.name === "bridge execute smoke test completes")?.ok).toBe(true);
      expect(checks.find((check) => check.name === "transport is PTY")?.ok).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);
});
