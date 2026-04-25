import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesAcceptance } from "../../src/cli/acceptance-hermes.js";

const createdPaths: string[] = [];
const originalHermesCommand = process.env.HERMES_COMMAND;
const originalHermesRepoPath = process.env.HERMES_REPO_PATH;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  process.env.HERMES_COMMAND = originalHermesCommand;
  process.env.HERMES_REPO_PATH = originalHermesRepoPath;
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("runHermesAcceptance", () => {
  it("runs in embedded mode without an external bridge or token setup", async () => {
    const repoPath = await makeTempDir("pi-hermes-acceptance-repo-");
    process.env.HERMES_COMMAND = process.execPath;
    process.env.HERMES_REPO_PATH = repoPath;

    const result = await runHermesAcceptance({
      mode: "embedded",
      workdir: repoPath,
      timeoutMs: 15000,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "pty",
      },
    });

    expect(result.mode).toBe("embedded");
    expect(result.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  }, 20_000);
});
