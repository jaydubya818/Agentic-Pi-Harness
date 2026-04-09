import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
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
});
