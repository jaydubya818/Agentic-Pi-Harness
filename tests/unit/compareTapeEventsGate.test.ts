import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import type { StreamEvent } from "../../src/schemas/index.js";

const execFileAsync = promisify(execFile);
const TSX = resolve("node_modules/.bin/tsx");
const SCRIPT = resolve("scripts/compare-tape-events.ts");

/**
 * `scripts/compare-tape-events.ts` is the Level A drift gate in the
 * `golden-proof` job of `.github/workflows/ci.yml`, and it had no test.
 * These cases are characterization: they pin which parts of a tape the gate
 * reads (the normalized header fields, then every event record positionally)
 * and — just as important — which parts it deliberately ignores, because
 * two independent runs of the golden path differ in exactly those.
 */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

interface TapeOptions {
  sessionId?: string;
  createdAt?: string;
  loopGitSha?: string;
  policyDigest?: string;
  events?: StreamEvent[];
}

const DEFAULT_EVENTS: StreamEvent[] = [
  { type: "message_start", schemaVersion: 1 },
  { type: "text_delta", schemaVersion: 1, text: "hello" },
  { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
];

async function writeTape(dir: string, name: string, options: TapeOptions = {}): Promise<string> {
  const path = join(dir, name);
  const tape = new ReplayRecorder(path);
  await tape.writeHeader({
    sessionId: options.sessionId ?? "session-1",
    loopGitSha: options.loopGitSha ?? "dev",
    policyDigest: options.policyDigest ?? "sha256:policy-test",
    costTableVersion: "2026-04-01",
    createdAt: options.createdAt ?? "2026-04-08T00:00:00.000Z",
  });
  for (const event of options.events ?? DEFAULT_EVENTS) await tape.writeEvent(event);
  return path;
}

describe("Level A tape-event drift gate (scripts/compare-tape-events.ts)", () => {
  it("accepts two tapes with identical headers and events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");
    const b = await writeTape(dir, "b.jsonl");

    const result = await run([a, b]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tapes match: 3 event records");
  });

  it("ignores the session id, the createdAt stamp, and the hash chain that descends from it", async () => {
    // This is the whole point of the gate: two runs of the same golden path
    // produce different session ids and different `createdAt` values, so
    // every `prevHash`/`recordHash` in the chain differs. Only the five
    // normalized header fields and the event bodies are compared.
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");
    const b = await writeTape(dir, "b.jsonl", {
      sessionId: "session-other",
      createdAt: "2027-01-01T00:00:00.000Z",
    });

    // Guard the premise: the two files really are byte-different.
    expect(await readFile(a, "utf8")).not.toBe(await readFile(b, "utf8"));
    expect((await run([a, b])).code).toBe(0);
  });

  it("rejects a diverging header field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");

    const shaDrift = await writeTape(dir, "sha.jsonl", { loopGitSha: "other-sha" });
    const shaResult = await run([a, shaDrift]);
    expect(shaResult.code).toBe(1);
    expect(shaResult.stderr).toContain("drift: tape headers diverge");

    const policyDrift = await writeTape(dir, "policy.jsonl", { policyDigest: "sha256:other" });
    expect((await run([a, policyDrift])).code).toBe(1);
  });

  it("rejects a diverging event count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");
    const b = await writeTape(dir, "b.jsonl", { events: DEFAULT_EVENTS.slice(0, 2) });

    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("drift: event record count 3 vs 2");
  });

  it("rejects a changed event body and names the 1-based record index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");
    const b = await writeTape(dir, "b.jsonl", {
      events: [
        DEFAULT_EVENTS[0],
        { type: "text_delta", schemaVersion: 1, text: "goodbye" },
        DEFAULT_EVENTS[2],
      ],
    });

    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("drift: event record 2 diverges");
  });

  it("rejects an empty tape rather than reporting a match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");
    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "", "utf8");

    const result = await run([a, empty]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("drift: one or both tapes are empty");
  });

  it("exits 2 on a missing argument, which is how CI fails when the run produced no tape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cmp-tape-"));
    const a = await writeTape(dir, "a.jsonl");

    const result = await run([a]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: compare-tape-events.ts");
  });
});
