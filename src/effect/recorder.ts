import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { EffectRecord } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

async function hashFile(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    const buf = await readFile(path);
    return "sha256:" + createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readText(path: string): Promise<string | null> {
  try {
    const b = await readFile(path);
    if (isBinary(b)) return null;
    return b.toString("utf8");
  } catch {
    return null;
  }
}

function unifiedDiff(a: string, b: string, path: string): string {
  // Minimal: not a real diff lib. One hunk, whole-file replace.
  if (a === b) return "";
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  return (
    `--- a/${path}\n+++ b/${path}\n@@ -1,${aLines.length} +1,${bLines.length} @@\n` +
    aLines.map((l) => "-" + l).join("\n") + "\n" +
    bLines.map((l) => "+" + l).join("\n") + "\n"
  );
}

export class EffectRecorder {
  private pre = new Map<string, { hash: string | null; text: string | null }>();

  async snapshotPre(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        const hash = await hashFile(p);
        const text = await readText(p);
        this.pre.set(p, { hash: hash ?? "absent", text });
      } catch (e) {
        throw new PiHarnessError("E_EFFECT_PRE_HASH", `pre-hash failed for ${p}`, { cause: String(e) });
      }
    }
  }

  async capturePost(toolCallId: string, toolName: string, paths: string[]): Promise<EffectRecord> {
    const preHashes: Record<string, string> = {};
    const postHashes: Record<string, string> = {};
    const diffs: string[] = [];
    let binaryChanged = false;

    for (const p of paths) {
      const preEntry = this.pre.get(p) ?? { hash: "absent", text: null };
      const postHash = (await hashFile(p)) ?? "absent";
      preHashes[p] = preEntry.hash ?? "absent";
      postHashes[p] = postHash;

      if (preEntry.hash === postHash) continue;

      const postText = await readText(p);
      if (preEntry.text == null || postText == null) {
        binaryChanged = true;
        continue;
      }
      diffs.push(unifiedDiff(preEntry.text, postText, p));
    }

    return {
      schemaVersion: 1,
      toolCallId,
      toolName,
      paths: [...paths].sort(),
      preHashes,
      postHashes,
      unifiedDiff: diffs.join("\n"),
      binaryChanged,
      rollbackConfidence: binaryChanged ? "best_effort" : "high",
      at: new Date().toISOString(),
    };
  }
}
