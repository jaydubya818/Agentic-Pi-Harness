import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenticKbMemoryProvider } from "../../src/memory/agenticKbMemoryProvider.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

async function seedKbFixture(): Promise<string> {
  const kbRoot = await makeTempDir("pi-kb-fixture-");
  await mkdir(join(kbRoot, "wiki", "personal", "agent-bootstrap"), { recursive: true });
  await mkdir(join(kbRoot, "wiki", "patterns"), { recursive: true });
  await mkdir(join(kbRoot, "wiki", "agents", "workers", "gsd-executor"), { recursive: true });
  await mkdir(join(kbRoot, "config", "agents"), { recursive: true });
  await mkdir(join(kbRoot, "cli"), { recursive: true });

  await writeFile(join(kbRoot, "wiki", "personal", "agent-bootstrap", "pi.md"), `---\ntitle: Pi Bootstrap Append\n---\n\nPi bootstrap worker prompt.\n`, "utf8");
  await writeFile(join(kbRoot, "wiki", "personal", "hermes-operating-context.md"), `---\ntitle: Hermes Operating Context\n---\n\nHermes routes work and manages priorities.\n`, "utf8");
  await writeFile(join(kbRoot, "wiki", "patterns", "pattern-supervisor-worker.md"), `---\ntitle: Supervisor Worker Pattern\n---\n\nSupervisor routes tasks to workers.\n`, "utf8");
  await writeFile(join(kbRoot, "wiki", "agents", "workers", "gsd-executor", "profile.md"), "# Worker profile\n", "utf8");
  await writeFile(join(kbRoot, "wiki", "agents", "workers", "gsd-executor", "hot.md"), "# Worker hot memory\n", "utf8");
  await writeFile(join(kbRoot, "wiki", "agents", "workers", "gsd-executor", "gotchas.md"), "# Worker gotchas\n", "utf8");
  await writeFile(join(kbRoot, "config", "agents", "gsd-executor.yaml"), "agent_id: gsd-executor\ntier: worker\n", "utf8");
  await writeFile(join(kbRoot, "cli", "kb.js"), "#!/usr/bin/env node\n", "utf8");

  return kbRoot;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgenticKbMemoryProvider", () => {
  it("disables gracefully when KB path is missing", async () => {
    const provider = new AgenticKbMemoryProvider({
      kbRoot: join(tmpdir(), "does-not-exist-kb"),
      accessMode: "local",
    });

    const health = await provider.healthCheck();

    expect(health.enabled).toBe(false);
    expect(health.reason).toMatch(/missing/i);
  });

  it("searches and reads wiki articles from a local fixture", async () => {
    const kbRoot = await seedKbFixture();
    const provider = new AgenticKbMemoryProvider({
      kbRoot,
      accessMode: "local",
      maxResults: 5,
    });

    const results = await provider.search("pi bootstrap", { limit: 3 });
    const article = await provider.get("personal/agent-bootstrap/pi");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe("personal/agent-bootstrap/pi");
    expect(article?.title).toBe("Pi Bootstrap Append");
    expect(article?.content).toContain("Pi bootstrap worker prompt");
  });

  it("loads scoped agent context via local CLI output and reads included files", async () => {
    const kbRoot = await seedKbFixture();
    const provider = new AgenticKbMemoryProvider({
      kbRoot,
      accessMode: "local",
      commandRunner: vi.fn(async () => ({
        stdout: [
          "=== Context for gsd-executor (worker) ===",
          "Budget: 128/40960 bytes",
          "Files included (2):",
          "  [profile] wiki/agents/workers/gsd-executor/profile.md (17B) — class=profile scope=self",
          "  [hot] wiki/agents/workers/gsd-executor/hot.md (20B) — class=hot scope=self",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      })),
    });

    const bundle = await provider.loadAgentContext("gsd-executor", { project: "bootstrap-pi-acceptance" });

    expect(bundle?.agentId).toBe("gsd-executor");
    expect(bundle?.items).toHaveLength(2);
    expect(bundle?.items[0]?.content).toContain("Worker profile");
    expect(bundle?.items[1]?.className).toBe("hot");
  });

  it("keeps writeback disabled by default", async () => {
    const kbRoot = await seedKbFixture();
    const provider = new AgenticKbMemoryProvider({
      kbRoot,
      accessMode: "local",
    });

    const result = await provider.closeAgentTask("gsd-executor", { taskLogEntry: "done" });

    expect(result.performed).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });
});
