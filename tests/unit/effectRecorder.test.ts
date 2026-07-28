import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEffectRecord,
  EffectRecorder,
  readEffectLog,
  renderWhatChanged,
} from "../../src/effect/recorder.js";

describe("effect recorder", () => {
  it("captures one effect record per mutating tool call with deterministic path ordering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-effect-"));
    const a = join(dir, "b.txt");
    const b = join(dir, "a.txt");

    await writeFile(a, "before-b\n");
    await writeFile(b, "before-a\n");

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([a, b], "tool-1");

    await writeFile(a, "after-b\n");
    await writeFile(b, "after-a\n");

    const record = await recorder.capturePost("session-1", "tool-1", "write_file", [a, b]);

    expect(record.sessionId).toBe("session-1");
    expect(record.paths).toEqual([b, a].sort((x, y) => x.localeCompare(y)));
    expect(record.preHashes[b]).toMatch(/^sha256:/);
    expect(record.postHashes[b]).toMatch(/^sha256:/);
    expect(record.unifiedDiff).toContain("--- a/");
    expect(record.unifiedDiff).toContain("+++ b/");
  });

  it("records hashes plus an omission marker instead of diffing huge files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-effect-huge-"));
    const file = join(dir, "big.txt");
    const before = Array.from({ length: 3000 }, (_, i) => `before ${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `after ${i}`).join("\n");
    await writeFile(file, before);

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([file], "tool-huge");
    await writeFile(file, after);
    const record = await recorder.capturePost("session-1", "tool-huge", "write_file", [file]);

    expect(record.preHashes[file]).toMatch(/^sha256:/);
    expect(record.postHashes[file]).toMatch(/^sha256:/);
    expect(record.unifiedDiff).toContain("diff omitted");
    expect(record.unifiedDiff.length).toBeLessThan(500);
  });

  it("discard releases a pre-snapshot scope so a failed tool call does not retain it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-effect-discard-"));
    const file = join(dir, "f.txt");
    await writeFile(file, "before\n");

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([file], "tool-fail");
    recorder.discard("tool-fail");

    // A later capture for the same call id must not see the stale snapshot.
    const record = await recorder.capturePost("session-1", "tool-fail", "write_file", [file]);
    expect(record.preHashes[file]).toBe("absent");
  });

  it("releases the back-compat default scope after capturePost consumes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-effect-default-"));
    const file = join(dir, "f.txt");
    await writeFile(file, "v1\n");

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([file]);
    await writeFile(file, "v2\n");
    const first = await recorder.capturePost("session-1", "call-1", "write_file", [file]);
    expect(first.unifiedDiff).toContain("-v1");

    // The default scope was consumed; a capture without a fresh snapshot
    // must not reuse the v1 pre-state.
    const second = await recorder.capturePost("session-1", "call-2", "write_file", [file]);
    expect(second.preHashes[file]).toBe("absent");
  });

  it("writes, reads, and renders effect logs for what-changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-effect-log-"));
    const path = join(dir, "effects.jsonl");
    const file = join(dir, "f.txt");

    await writeFile(file, "before\n");

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([file], "tool-1");
    await writeFile(file, "after\n");
    const record = await recorder.capturePost("session-1", "tool-1", "write_file", [file]);

    await appendEffectRecord(path, record);

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const records = await readEffectLog(path);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);

    const rendered = renderWhatChanged(records);
    expect(rendered).toContain("# write_file (tool-1)");
    expect(rendered).toContain(file);
    expect(rendered).toContain("--- a/");
  });
});
