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
