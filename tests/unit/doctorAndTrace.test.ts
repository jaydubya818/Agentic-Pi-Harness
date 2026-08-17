import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../../src/cli/doctor.js";
import { parseRunCliArgs, runGoldenPath } from "../../src/cli/run.js";

describe("doctor and trace polish", () => {
  it("doctor includes the committed golden tape verification check", async () => {
    const checks = await doctor();
    const goldenCheck = checks.find((check) => check.name === "canonical golden tape verifies");

    expect(goldenCheck).toBeDefined();
    expect(goldenCheck?.ok).toBe(true);
    expect(goldenCheck?.detail).toContain("sha256:");
  });

  it("parseRunCliArgs resolves the default trace path", async () => {
    const parsed = await parseRunCliArgs(["./workdir", "./outdir", "--trace"]);

    expect(parsed.workdir).toBe("./workdir");
    expect(parsed.outRoot).toBe("./outdir");
    expect(parsed.tracePath).toContain(".pi/traces/latest.jsonl");
  });

  it("parseRunCliArgs rejects typo'd flags instead of using them as the workdir", async () => {
    await expect(parseRunCliArgs(["--trcae=/tmp/x", "./work", "./out"])).rejects.toThrow(/unknown flag/);
    // A known flag spelled without its value is still a mistake.
    await expect(parseRunCliArgs(["--trace=", "./work"])).rejects.toThrow(/invalid --trace= value/);
    // Extra positionals are a mistake too (the CLI only takes two).
    await expect(parseRunCliArgs(["./work", "./out", "./extra"])).rejects.toThrow(/unexpected argument/);
    // The supported spellings still parse.
    const parsed = await parseRunCliArgs(["./work", "./out", "--trace=/tmp/t.jsonl"]);
    expect(parsed).toEqual({ workdir: "./work", outRoot: "./out", tracePath: "/tmp/t.jsonl" });
  });

  it("runGoldenPath writes a lightweight JSONL trace when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-trace-"));
    const workdir = join(dir, "work");
    const outRoot = join(dir, "out");
    const tracePath = join(dir, "trace.jsonl");

    await runGoldenPath(workdir, outRoot, { tracePath });

    const trace = await readFile(tracePath, "utf8");
    const lines = trace.split("\n").filter(Boolean).map((line) => JSON.parse(line));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].event.type).toBe("message_start");
    expect(lines.some((line) => line.event.type === "tool_use" && line.event.name === "read_file")).toBe(true);
    expect(lines.some((line) => line.event.type === "tool_result" && line.event.id === "t2")).toBe(true);
  });

  it("recreates a trace directory that disappeared after it was first ensured", async () => {
    // appendJsonl memoizes the directories it has already created, so a
    // trace root removed between runs (test teardown, an operator clearing
    // an out root) must not make every later append fail with ENOENT.
    const dir = await mkdtemp(join(tmpdir(), "pi-trace-"));
    const traceDir = join(dir, "traces");
    const tracePath = join(traceDir, "trace.jsonl");

    await runGoldenPath(join(dir, "work1"), join(dir, "out1"), { tracePath });
    await rm(traceDir, { recursive: true, force: true });
    await runGoldenPath(join(dir, "work2"), join(dir, "out2"), { tracePath });

    const lines = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
  });
});
