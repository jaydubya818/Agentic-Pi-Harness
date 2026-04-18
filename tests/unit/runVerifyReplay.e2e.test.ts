import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoldenPath } from "../../src/cli/run.js";
import { readTape, verifyTape } from "../../src/replay/recorder.js";

/**
 * End-to-end: run the golden path, verify the resulting tape, then re-read
 * it and confirm hash-chain continuity — exercising the new append-mode
 * ReplayRecorder alongside the CLI wiring.
 */
describe("e2e: run → verify → replay", () => {
  it("produces a verifiable, deterministic tape via the append writer", async () => {
    const work = await mkdtemp(join(tmpdir(), "pi-e2e-work-"));
    const out = await mkdtemp(join(tmpdir(), "pi-e2e-out-"));

    const sessionId = await runGoldenPath(work, out);
    expect(sessionId).toMatch(/^golden-[a-z0-9-]+$/);

    const tapes = await readdir(join(out, "tapes"));
    expect(tapes).toEqual([`${sessionId}.jsonl`]);
    const tapePath = join(out, "tapes", tapes[0]);

    // verifyTape walks the hash chain from header through every event.
    const result = await verifyTape(tapePath);
    expect(result.ok).toBe(true);
    expect(result.records).toBe(9); // header + 8 scripted stream events
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Append writer must end every line with "\n" (JSONL invariant).
    const raw = await readFile(tapePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(9);

    // Second verify against the parsed record list: idempotent, same digest.
    const records = await readTape(tapePath);
    expect(records).toHaveLength(9);
    expect(records[0].type).toBe("header");
    expect(records[records.length - 1].recordHash).toBe(result.digest);
  }, 10_000);

  it("writes effect and policy logs alongside the tape", async () => {
    const work = await mkdtemp(join(tmpdir(), "pi-e2e2-work-"));
    const out = await mkdtemp(join(tmpdir(), "pi-e2e2-out-"));

    const sessionId = await runGoldenPath(work, out);

    const effectLog = join(out, "effects", `${sessionId}.jsonl`);
    const sessionDir = join(out, "sessions", sessionId);
    const policyLog = join(sessionDir, "policy.jsonl");
    const checkpoint = join(sessionDir, "checkpoint.json");

    const effects = await readFile(effectLog, "utf8");
    expect(effects.length).toBeGreaterThan(0);
    // Mutating tools (write_file) produce effect records on the golden path.
    expect(effects.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(1);

    const policy = await readFile(policyLog, "utf8");
    expect(policy.length).toBeGreaterThan(0);

    const cp = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(cp.sessionId).toBe(sessionId);
  }, 10_000);
});
