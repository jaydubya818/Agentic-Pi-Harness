import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesDemo } from "../../src/cli/hermes-demo.js";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";
import { ensureKnowledgeDirectorySkeleton } from "../../src/hermes/kbAccessPolicy.js";

const createdPaths: string[] = [];
const envKeys = ["BRIDGE_ONLY_GOVERNED_EXECUTION", "DEV_BYPASS_DIRECT_HERMES"] as const;
const envSnapshot = new Map<string, string | undefined>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  for (const key of envKeys) {
    const value = envSnapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    envSnapshot.delete(key);
  }
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("governed routing hardening", () => {
  it("persists preflight denials for forbidden governed writes", async () => {
    const stateRoot = await makeTempDir("pi-hermes-preflight-state-");
    const workdir = await makeTempDir("pi-hermes-preflight-work-");
    const roots = await ensureKnowledgeDirectorySkeleton({
      agenticKbRoot: await makeTempDir("agentic-kb-preflight-"),
      llmWikiRoot: await makeTempDir("llm-wiki-preflight-"),
    });

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      knowledgeRoots: roots,
      enforceKnowledgePolicy: true,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes-contract-v2.mjs")],
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
      const forbiddenPath = join(roots.agenticKbRoot, "knowledge", "promoted", "forbidden.md");
      const response = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "2.0",
          request_id: "req_denied_1",
          run_id: "run_denied_1",
          mission_id: "mission_denied_1",
          session_id: session.session_id,
          execution_id: "exec_denied_1",
          task_type: "repo_inspection",
          goal: "Attempt forbidden write.",
          instructions: ["Try to write into a canonical path."],
          constraints: {
            network_access: false,
            write_access: true,
            path_allowlist: [forbiddenPath],
            path_denylist: [],
          },
          allowed_tools: ["bash"],
          disallowed_tools: [],
          workdir,
          timeout_seconds: 20,
          artifacts_expected: [
            { type: "summary", role: "primary_result", path: forbiddenPath, required: true },
            { type: "result", role: "primary_result", path: forbiddenPath.replace(/\.md$/, ".json"), required: true },
            { type: "manifest", role: "primary_result", path: forbiddenPath.replace(/\.md$/, ".manifest.json"), required: true },
            { type: "trace", role: "supporting_log", path: join(roots.llmWikiRoot, "drafts", "trace.json"), required: true },
          ],
          approval_policy: { mode: "never", allow_interrupt: true, allow_cancel: true },
          priority: "normal",
          metadata: { step_id: "step-1" },
        }),
      });
      expect(response.status).toBe(400);

      const denialsResponse = await fetch(`${base}/preflight-denials`);
      const denials = await denialsResponse.json() as Array<{ code: string; request_id?: string; execution_id?: string; message: string }>;
      expect(denials.some((record) => record.code === "v2_preflight_denied" && record.request_id === "req_denied_1" && record.execution_id === "exec_denied_1")).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("bridge-only mode blocks direct dev-only adapter tooling unless bypass is explicit", async () => {
    for (const key of envKeys) envSnapshot.set(key, process.env[key]);
    process.env.BRIDGE_ONLY_GOVERNED_EXECUTION = "true";
    delete process.env.DEV_BYPASS_DIRECT_HERMES;

    await expect(runHermesDemo([
      "--workdir", await makeTempDir("pi-hermes-demo-work-"),
      "--output-dir", await makeTempDir("pi-hermes-demo-out-"),
      "--command", process.execPath,
    ])).rejects.toThrow(/BRIDGE_ONLY_GOVERNED_EXECUTION/);
  });
});
