import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesSupervisorTask } from "../../src/orchestration/hermesSupervisor.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("runHermesSupervisorTask", () => {
  it("runs Hermes through a higher-level Pi orchestration path", async () => {
    const workdir = await makeTempDir("pi-hermes-supervisor-work-");
    const outRoot = await makeTempDir("pi-hermes-supervisor-out-");

    const result = await runHermesSupervisorTask({
      objective: "Write a report into the artifact dir and summarize it.",
      workdir,
      outRoot,
      timeoutSeconds: 20,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
      },
    });

    expect(result.result.status).toBe("completed");
    expect(result.accepted.status).toBe("accepted");
    expect(result.result.summary).toContain("Fake Hermes completed successfully");
    expect(result.session_dir).toContain(outRoot);
    expect(result.artifact_dir).toContain(result.session_dir);
    expect(result.bridge_url).toContain("http://127.0.0.1:");
  }, 15000);
});
