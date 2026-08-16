import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, appendFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { verifyTape } from "../../src/cli/verify.js";
import { sha256HexFramed } from "../../src/schemas/canonical.js";

async function freshTape() {
  const dir = await mkdtemp(join(tmpdir(), "pi-chaos-"));
  const path = join(dir, "t.jsonl");
  const r = new ReplayRecorder(path);
  await r.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });
  await r.writeEvent({ type: "message_start", schemaVersion: 1 });
  await r.writeEvent({ type: "text_delta", schemaVersion: 1, text: "hello" });
  await r.writeEvent({ type: "tool_use", schemaVersion: 1, id: "t1", name: "read", input: { path: "a" } });
  await r.writeEvent({ type: "message_stop", schemaVersion: 1, stopReason: "end_turn" });
  return path;
}

describe("chaos: tape corruption is always detected", () => {
  it("detects flipped byte mid-record", async () => {
    const p = await freshTape();
    const raw = await readFile(p, "utf8");
    const tampered = raw.replace('"hello"', '"helLo"');
    await writeFile(p, tampered);
    const v = await verifyTape(p);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/recordHash mismatch|prevHash mismatch/);
  });

  it("detects truncated final line (partial write)", async () => {
    const p = await freshTape();
    const stat = (await readFile(p, "utf8"));
    // Chop off the last 20 bytes to simulate a crash mid-append.
    await truncate(p, Buffer.byteLength(stat, "utf8") - 20);
    const v = await verifyTape(p);
    expect(v.ok).toBe(false);
  });

  it("detects reordered events (swap two middle lines)", async () => {
    const p = await freshTape();
    const lines = (await readFile(p, "utf8")).split("\n").filter(Boolean);
    [lines[1], lines[2]] = [lines[2], lines[1]];
    await writeFile(p, lines.join("\n") + "\n");
    const v = await verifyTape(p);
    expect(v.ok).toBe(false);
    // Out-of-order seq is caught before the chain walk gets to the hash;
    // either signal is a valid detection of the same corruption.
    expect(v.error).toMatch(/prevHash mismatch|expected seq/);
  });

  it("detects a second header record spliced into a fully re-chained tape", async () => {
    const p = await freshTape();
    const records = (await readFile(p, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // Two sessions concatenated. The hash chain is recomputable by anyone,
    // so re-chaining every record afterwards makes the splice invisible to
    // the chain walk; only the structural check catches it.
    const spliced = [records[0], records[1], { ...records[0] }, ...records.slice(2)];
    let prevHash = "0".repeat(64);
    const rechained = spliced.map((record) => {
      const { recordHash: _drop, ...rest } = record;
      const base = { ...rest, prevHash };
      const next = { ...base, recordHash: "sha256:" + sha256HexFramed("pi-tape-v1", base) };
      prevHash = next.recordHash;
      return next;
    });
    await writeFile(p, rechained.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const v = await verifyTape(p);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unexpected header record mid-tape/);
  });

  it("detects injected bogus record at tail", async () => {
    const p = await freshTape();
    await appendFile(p, JSON.stringify({ type: "event", schemaVersion: 1, seq: 999, event: { type: "text_delta", schemaVersion: 1, text: "evil" }, prevHash: "0".repeat(64), recordHash: "sha256:" + "e".repeat(64) }) + "\n");
    const v = await verifyTape(p);
    expect(v.ok).toBe(false);
  });
});
