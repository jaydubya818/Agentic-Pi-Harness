import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTape, ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";

describe("replay tape verify", () => {
  it("verifies a recorded tape and reads it back with schema validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-"));
    const tape = join(dir, "t.jsonl");
    const r = new ReplayRecorder(tape);
    await r.writeHeader({ sessionId: "s1", loopGitSha: "abc", policyDigest: "sha256:xx", costTableVersion: "v1" });
    await r.writeEvent({ type: "message_start", schemaVersion: 1 });
    await r.writeEvent({ type: "text_delta", schemaVersion: 1, text: "hi" });
    await r.writeEvent({ type: "message_stop", schemaVersion: 1, stopReason: "end_turn" });
    const res = await verifyTape(tape);
    expect(res.ok).toBe(true);
    expect(res.records).toBe(4);

    const records = await readTape(tape);
    expect(records).toHaveLength(4);
    expect(records[0].type).toBe("header");
    expect(records[1].type).toBe("event");
  });

  it("writes crash-safely without leaving temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-"));
    const tape = join(dir, "t.jsonl");
    const r = new ReplayRecorder(tape);
    await r.writeHeader({ sessionId: "s1", loopGitSha: "abc", policyDigest: "sha256:xx", costTableVersion: "v1" });
    await r.writeEvent({ type: "text_delta", schemaVersion: 1, text: "hi" });

    const entries = await readdir(dir);
    expect(entries).toContain("t.jsonl");
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("detects tampering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-"));
    const tape = join(dir, "t.jsonl");
    const r = new ReplayRecorder(tape);
    await r.writeHeader({ sessionId: "s1", loopGitSha: "abc", policyDigest: "sha256:xx", costTableVersion: "v1" });
    await r.writeEvent({ type: "text_delta", schemaVersion: 1, text: "hi" });
    const content = await readFile(tape, "utf8");
    await writeFile(tape, content.replace('"hi"', '"HI"'));
    const res = await verifyTape(tape);
    expect(res.ok).toBe(false);
  });
});
