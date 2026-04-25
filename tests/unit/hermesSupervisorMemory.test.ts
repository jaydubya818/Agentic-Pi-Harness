import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesSupervisorTask, type MemoryProvider } from "../../src/orchestration/hermesSupervisor.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("runHermesSupervisorTask memory integration", () => {
  it("falls back to an embedded bridge and records memory evidence in the task report", async () => {
    const workdir = await makeTempDir("pi-hermes-supervisor-memory-work-");
    const outRoot = await makeTempDir("pi-hermes-supervisor-memory-out-");
    const stateRoot = await makeTempDir("pi-hermes-supervisor-memory-state-");

    const memoryProvider: MemoryProvider = {
      async healthCheck() {
        return { enabled: true, ok: true, mode: "local" };
      },
      async buildContextPack() {
        return {
          used: true,
          available: true,
          source: "local",
          query: "pi bootstrap",
          agentId: "gsd-executor",
          items: [
            {
              kind: "search",
              slug: "personal/agent-bootstrap/pi",
              title: "Pi Bootstrap Append",
              path: "wiki/personal/agent-bootstrap/pi.md",
              reason: "search match",
              excerpt: "Pi should load context before execution.",
              score: 5,
              source: "local",
            },
            {
              kind: "agent-context",
              title: "Worker hot",
              path: "wiki/agents/workers/gsd-executor/hot.md",
              reason: "class=hot scope=self",
              excerpt: "Worker hot context.",
              source: "local",
            },
          ],
          text: "Advisory memory context from Agentic-KB. Pi should load context before execution.",
          budgetChars: 6000,
          usedChars: 82,
          truncated: false,
          warnings: [],
        };
      },
      async search() {
        return [];
      },
      async get() {
        return null;
      },
      async loadAgentContext() {
        return null;
      },
      async closeAgentTask() {
        return { performed: false, reason: "disabled by default" };
      },
    };

    const result = await runHermesSupervisorTask({
      objective: "Write a report into the artifact dir and summarize it.",
      workdir,
      outRoot,
      timeoutSeconds: 20,
      bridgeUrl: "http://127.0.0.1:1",
      bridgeTimeoutMs: 50,
      memoryProvider,
      useAgenticKbMemory: true,
      memoryQuery: "pi bootstrap",
      memoryAgentId: "gsd-executor",
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const storedRequest = JSON.parse(await readFile(result.request_path, "utf8")) as { objective: string };

    expect(result.result.status).toBe("completed");
    expect(result.bridge_mode).toBe("embedded");
    expect(result.bridge_fallback_reason ?? "").toMatch(/unavailable|health/i);
    expect(result.context_report.memory_used).toBe(true);
    expect(result.context_report.agent_context_loaded).toBe(true);
    expect(result.context_report.writeback_performed).toBe(false);
    expect(result.context_report.sources.some((source) => source.slug === "personal/agent-bootstrap/pi")).toBe(true);
    expect(storedRequest.objective).toContain("Advisory memory context from Agentic-KB");
  }, 15_000);
});
