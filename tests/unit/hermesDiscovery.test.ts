import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHermesBinaryPath, detectHermesRepoPath } from "../../src/hermes/discovery.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hermes discovery", () => {
  it("resolves an explicit executable file", async () => {
    const base = await makeTempDir("pi-discovery-");
    const binary = join(base, "hermes");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);

    expect(detectHermesBinaryPath({ HERMES_COMMAND: binary })).toBe(resolve(binary));
  });

  it("does not report a directory as the worker binary (X_OK passes on dirs)", async () => {
    const base = await makeTempDir("pi-discovery-");
    const dirNamedHermes = join(base, "hermes");
    await mkdir(dirNamedHermes);

    // Falls through to the ~/.local/bin/hermes default probe; the explicit
    // directory must not win.
    expect(detectHermesBinaryPath({ HERMES_COMMAND: dirNamedHermes })).not.toBe(resolve(dirNamedHermes));
  });

  it("resolves an explicit readable repo directory", async () => {
    const base = await makeTempDir("pi-discovery-");
    const repo = join(base, "hermes-agent");
    await mkdir(repo);

    expect(detectHermesRepoPath({ HERMES_REPO_PATH: repo })).toBe(resolve(repo));
  });

  it("does not report a regular file as the worker repo (R_OK passes on files)", async () => {
    const base = await makeTempDir("pi-discovery-");
    const fileNamedRepo = join(base, "hermes-agent");
    await writeFile(fileNamedRepo, "not a repo\n", "utf8");

    expect(detectHermesRepoPath({ HERMES_REPO_PATH: fileNamedRepo })).not.toBe(resolve(fileNamedRepo));
  });
});
