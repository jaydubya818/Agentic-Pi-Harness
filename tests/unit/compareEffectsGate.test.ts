import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EffectRecord } from "../../src/schemas/index.js";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("scripts/compare-effects.mjs");

/**
 * `scripts/compare-effects.mjs` is one of the four drift gates the
 * `golden-proof` job in `.github/workflows/ci.yml` runs against the committed
 * goldens, and it had no test of any kind. These cases are characterization:
 * they pin what the gate does today — including the two things it
 * deliberately does not detect — so that a change to the signature fails
 * here rather than silently in CI.
 */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    schemaVersion: 1,
    toolCallId: "t1",
    sessionId: "session-1",
    toolName: "write_file",
    paths: ["/work-a/src/a.ts"],
    preHashes: { "/work-a/src/a.ts": "sha256:aaa" },
    postHashes: { "/work-a/src/a.ts": "sha256:bbb" },
    unifiedDiff: "",
    binaryChanged: false,
    timestamp: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

async function writeLog(dir: string, name: string, records: EffectRecord[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

describe("Level B effect-drift gate (scripts/compare-effects.mjs)", () => {
  it("accepts two identical effect logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);
    const b = await writeLog(dir, "b.jsonl", [effect()]);

    const result = await run([a, b]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("replay deterministic: 1 effect records match");
  });

  it("rejects a differing record count before comparing signatures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect(), effect({ toolCallId: "t2" })]);
    const b = await writeLog(dir, "b.jsonl", [effect()]);

    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("replay drift: record count 2 vs 1");
  });

  it("rejects a changed post-hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);
    const b = await writeLog(dir, "b.jsonl", [
      effect({ postHashes: { "/work-a/src/a.ts": "sha256:ccc" } }),
    ]);

    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("replay drift: effect signatures diverge");
  });

  it("rejects a changed tool name and a changed binaryChanged flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);

    const toolDrift = await writeLog(dir, "tool.jsonl", [effect({ toolName: "edit_file" })]);
    expect((await run([a, toolDrift])).code).toBe(1);

    const binaryDrift = await writeLog(dir, "binary.jsonl", [effect({ binaryChanged: true })]);
    expect((await run([a, binaryDrift])).code).toBe(1);
  });

  it("is path-agnostic by design: the same hashes under different absolute paths match", async () => {
    // Two independent runs execute in two different workdirs, so the same
    // effect is keyed under different absolute paths. The gate compares the
    // sorted hash *values*, never the keys. Pinned because it is the reason
    // the check is written this way, not an accident.
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);
    const b = await writeLog(dir, "b.jsonl", [
      effect({
        paths: ["/work-b/src/a.ts"],
        preHashes: { "/work-b/src/a.ts": "sha256:aaa" },
        postHashes: { "/work-b/src/a.ts": "sha256:bbb" },
      }),
    ]);

    const result = await run([a, b]);
    expect(result.code).toBe(0);
  });

  it("does not detect two paths in one record swapping their hashes", async () => {
    // The consequence of the path-agnostic signature, stated as a test so it
    // fails loudly the day the gate starts comparing per-path. A record that
    // wrote hash X to `one.ts` and Y to `two.ts` is indistinguishable from
    // one that wrote Y to `one.ts` and X to `two.ts`.
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const paths = ["/w/one.ts", "/w/two.ts"];
    const a = await writeLog(dir, "a.jsonl", [
      effect({
        paths,
        preHashes: { "/w/one.ts": "sha256:p1", "/w/two.ts": "sha256:p2" },
        postHashes: { "/w/one.ts": "sha256:x", "/w/two.ts": "sha256:y" },
      }),
    ]);
    const b = await writeLog(dir, "b.jsonl", [
      effect({
        paths,
        preHashes: { "/w/one.ts": "sha256:p1", "/w/two.ts": "sha256:p2" },
        postHashes: { "/w/one.ts": "sha256:y", "/w/two.ts": "sha256:x" },
      }),
    ]);

    const result = await run([a, b]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("replay deterministic");
  });

  it("does not read the diff, the timestamp, the session id, or the tool call id", async () => {
    // Non-determinism this gate is expected to tolerate: two runs stamp
    // different session ids and clock values, and the unified diff is
    // path-bearing text.
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);
    const b = await writeLog(dir, "b.jsonl", [
      effect({
        toolCallId: "t99",
        sessionId: "session-other",
        unifiedDiff: "--- a\n+++ b\n",
        timestamp: "2027-01-01T00:00:00.000Z",
      }),
    ]);

    expect((await run([a, b])).code).toBe(0);
  });

  it("exits 2 on a missing argument, which is how CI fails when the run produced no effect log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);

    const result = await run([a]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: compare-effects.mjs");
  });

  it("fails rather than passing when a log line is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-effects-"));
    const a = await writeLog(dir, "a.jsonl", [effect()]);
    const torn = join(dir, "torn.jsonl");
    await writeFile(torn, JSON.stringify(effect()).slice(0, 40) + "\n", "utf8");

    expect((await run([a, torn])).code).not.toBe(0);
  });
});
