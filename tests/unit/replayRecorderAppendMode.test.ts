import { describe, it, expect } from "vitest";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";

/**
 * Guards against regressing the 0.4.0 append-mode writer back into the old
 * O(N^2) "rewrite the whole tape" implementation.
 */
describe("ReplayRecorder append-mode invariants", () => {
  async function fresh(): Promise<{ path: string; tape: ReplayRecorder }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-append-"));
    const path = join(dir, "t.jsonl");
    const tape = new ReplayRecorder(path);
    await tape.writeHeader({
      sessionId: "s", loopGitSha: "g",
      policyDigest: "sha256:" + "0".repeat(64), costTableVersion: "v1",
    });
    return { path, tape };
  }

  it("file size grows monotonically across writeEvent calls", async () => {
    const { path, tape } = await fresh();
    const sizes: number[] = [];
    sizes.push((await stat(path)).size);
    for (let i = 0; i < 10; i++) {
      await tape.writeEvent({ type: "text_delta", schemaVersion: 1, text: `chunk-${i}` });
      sizes.push((await stat(path)).size);
    }
    await tape.close();
    // Strictly increasing — a rewrite-mode regression would sometimes shrink
    // (empty file → full file → empty file → full+1 file during tmp-rename).
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
    expect(sizes[sizes.length - 1]).toBeGreaterThanOrEqual(sizes[0] + 10);
  });

  it("every appended record remains verifiable as the chain extends", async () => {
    const { path, tape } = await fresh();
    for (let i = 0; i < 5; i++) {
      await tape.writeEvent({ type: "text_delta", schemaVersion: 1, text: `x${i}` });
      const v = await verifyTape(path);
      expect(v.ok).toBe(true);
      expect(v.records).toBe(i + 2); // header + i+1 events
    }
    await tape.close();
  });

  it("writeEvent after close raises E_TAPE_HASH", async () => {
    const { tape } = await fresh();
    await tape.writeEvent({ type: "message_start", schemaVersion: 1 });
    await tape.close();
    await expect(
      tape.writeEvent({ type: "message_stop", schemaVersion: 1, stopReason: "end_turn" })
    ).rejects.toThrow(/writeEvent before writeHeader or after close/);
  });

  it("close() is idempotent", async () => {
    const { tape } = await fresh();
    await tape.close();
    await tape.close();
    // no throw, no handle leak
  });

  it("writeHeader called twice closes the prior handle cleanly", async () => {
    const { path, tape } = await fresh();
    await tape.writeEvent({ type: "text_delta", schemaVersion: 1, text: "pre" });
    // Re-init the session — replaces the file atomically.
    await tape.writeHeader({
      sessionId: "s2", loopGitSha: "g",
      policyDigest: "sha256:" + "0".repeat(64), costTableVersion: "v1",
    });
    await tape.writeEvent({ type: "text_delta", schemaVersion: 1, text: "post" });
    await tape.close();

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Reset wrote a fresh header then one event — 2 records.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).sessionId).toBe("s2");
    const v = await verifyTape(path);
    expect(v.ok).toBe(true);
  });
});
