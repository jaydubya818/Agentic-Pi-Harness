import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHermesDoctor } from "../../src/cli/hermes-doctor.js";

const createdPaths: string[] = [];
const originalHermesCommand = process.env.HERMES_COMMAND;
const originalHermesRepoPath = process.env.HERMES_REPO_PATH;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

async function makeExecutableFile(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

afterEach(async () => {
  process.env.HERMES_COMMAND = originalHermesCommand;
  process.env.HERMES_REPO_PATH = originalHermesRepoPath;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("runHermesDoctor", () => {
  it("validates an authenticated bridge through deterministic mocked bridge responses", async () => {
    const workdir = await makeTempDir("pi-hermes-doctor-work-");
    const repoPath = await makeTempDir("pi-hermes-doctor-repo-");
    const roots = {
      agenticKbRoot: await makeTempDir("pi-hermes-doctor-kb-"),
      llmWikiRoot: await makeTempDir("pi-hermes-doctor-wiki-"),
    };
    const hermesBinary = join(await makeTempDir("pi-hermes-doctor-bin-"), "hermes");
    await makeExecutableFile(hermesBinary);
    process.env.HERMES_COMMAND = hermesBinary;
    process.env.HERMES_REPO_PATH = repoPath;

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/meta") && !init?.headers) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/meta")) {
        return new Response(JSON.stringify({
          binaryPath: hermesBinary,
          repoPath,
          authRequired: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/sessions") && method === "POST") {
        return new Response(JSON.stringify({ session_id: "sess_doctor" }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/execute") && method === "POST") {
        return new Response(JSON.stringify({ execution_id: "exec_doctor", status: "accepted" }), { status: 202, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/runs/exec_doctor")) {
        return new Response(JSON.stringify({ status: "completed" }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/runs/exec_doctor/events")) {
        return new Response(JSON.stringify({
          event_format: "json",
          items: [
            {
              type: "task.progress",
              data: {
                transport: "pty",
                transport_backend: "node-pty",
              },
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const checks = await runHermesDoctor({
      url: "http://127.0.0.1:8787",
      token: "doctor-secret",
      workdir,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      knowledgeRoots: roots,
    });

    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.find((check) => check.name === "bridge execute smoke test completes")?.detail).toBe("completed");
    expect(checks.find((check) => check.name === "transport is PTY")?.detail).toBe("pty");
    expect(fetchMock).toHaveBeenCalled();
  });
});
