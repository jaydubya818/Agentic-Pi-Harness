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
  if (a === b) return "";
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  return (
    `--- a/${path}\n+++ b/${path}\n@@ -1,${aLines.length} +1,${bLines.length} @@\n` +
    aLines.map((l) => "-" + l).join("\n") + "\n" +
    bLines.map((l) => "+" + l).join("\n") + "\n"
  );
}

type PreEntry = { hash: string; text: string | null };

/**
 * Per-call scope. Caller acquires a scope before running a tool, snapshots
 * into it, then captures. Scopes are disjoint so two concurrent calls to the
 * same path cannot clobber each other's pre state.
 */
export class EffectScope {
  private pre = new Map<string, PreEntry>();

  async snapshotPre(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        const hash = (await hashFile(p)) ?? "absent";
        const text = await readText(p);
        this.pre.set(p, { hash, text });
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
      preHashes[p] = preEntry.hash;
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

/**
 * Factory that hands out per-call scopes. The old `EffectRecorder` API is
 * kept for back-compat (golden path + tests) but `snapshotPre`/`capturePost`
 * now go through an internal scope keyed by toolCallId, so concurrent calls
 * to the same path are correctly isolated.
 */
export class EffectRecorder {
  private scopes = new Map<string, EffectScope>();

  scope(): EffectScope { return new EffectScope(); }

  /** Back-compat: sequential single-call API. */
  async snapshotPre(paths: string[], toolCallId = "__default__"): Promise<void> {
    let s = this.scopes.get(toolCallId);
    if (!s) { s = new EffectScope(); this.scopes.set(toolCallId, s); }
    await s.snapshotPre(paths);
  }

  async capturePost(toolCallId: string, toolName: string, paths: string[]): Promise<EffectRecord> {
    const s = this.scopes.get(toolCallId) ?? this.scopes.get("__default__") ?? new EffectScope();
    const rec = await s.capturePost(toolCallId, toolName, paths);
    this.scopes.delete(toolCallId);
    return rec;
  }
}
