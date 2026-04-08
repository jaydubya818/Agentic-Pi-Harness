import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffEffectLogs } from "../../src/replay/levelB.js";
import { EffectRecord } from "../../src/schemas/index.js";

const mk = (path: string, hash: string): EffectRecord => ({
  schemaVersion: 1, toolCallId: "t", toolName: "write_file",
  paths: [path], preHashes: { [path]: "sha256:0" }, postHashes: { [path]: hash },
  unifiedDiff: "", binaryChanged: false, rollbackConfidence: "high",
  at: "2026-04-08T00:00:00Z",
});

async function tmpLog(recs: EffectRecord[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lb-"));
  const p = join(dir, "effects.jsonl");
  await writeFile(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

describe("level-B effect drift", () => {
  it("matches identical logs", async () => {
    const a = await tmpLog([mk("a.ts", "sha256:aa"), mk("b.ts", "sha256:bb")]);
    const b = await tmpLog([mk("a.ts", "sha256:aa"), mk("b.ts", "sha256:bb")]);
    const d = await diffEffectLogs(a, b);
    expect(d.ok).toBe(true);
  });

  it("detects hash mismatch", async () => {
    const a = await tmpLog([mk("a.ts", "sha256:aa")]);
    const b = await tmpLog([mk("a.ts", "sha256:cc")]);
    const d = await diffEffectLogs(a, b);
    expect(d.ok).toBe(false);
    expect(d.hashMismatches).toHaveLength(1);
  });

  it("detects missing/extra paths", async () => {
    const a = await tmpLog([mk("a.ts", "sha256:aa")]);
    const b = await tmpLog([mk("b.ts", "sha256:bb")]);
    const d = await diffEffectLogs(a, b);
    expect(d.missing).toEqual(["a.ts"]);
    expect(d.extra).toEqual(["b.ts"]);
  });
});
