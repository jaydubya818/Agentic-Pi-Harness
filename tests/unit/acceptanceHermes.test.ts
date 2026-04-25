import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hermesDoctorModule from "../../src/cli/hermes-doctor.js";
import { runHermesAcceptance } from "../../src/cli/acceptance-hermes.js";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("runHermesAcceptance", () => {
  it("runs in embedded mode without an external bridge or token setup", async () => {
    const repoPath = await makeTempDir("pi-hermes-acceptance-repo-");
    const doctorChecks = [
      { name: "bridge execute smoke test completes", ok: true, detail: "completed" },
      { name: "transport is PTY", ok: true, detail: "pty" },
    ];

    const startSpy = vi.spyOn(HermesBridgeServer.prototype, "start").mockResolvedValue({ host: "127.0.0.1", port: 43123 });
    const stopSpy = vi.spyOn(HermesBridgeServer.prototype, "stop").mockResolvedValue();
    const doctorSpy = vi.spyOn(hermesDoctorModule, "runHermesDoctor").mockResolvedValue(doctorChecks);

    const result = await runHermesAcceptance({
      mode: "embedded",
      workdir: repoPath,
      timeoutMs: 15_000,
      adapterOptions: {
        command: process.execPath,
        preferTransport: "pty",
      },
    });

    expect(result).toEqual({
      ok: true,
      mode: "embedded",
      bridgeUrl: "http://127.0.0.1:43123",
      checks: doctorChecks,
    });
    expect(startSpy).toHaveBeenCalledOnce();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(doctorSpy).toHaveBeenCalledOnce();
    expect(doctorSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:43123",
      workdir: repoPath,
      timeoutMs: 15_000,
    }));
  });
});
