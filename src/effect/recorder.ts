import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { EffectRecord, EffectRecordSchema, parseOrThrow } from "../schemas/index.js";
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

/**
 * Minimal LCS-based unified diff. Good enough for small text files; no
 * external dependency so the harness stays self-contained. If we ever need
 * 3-way merges or word-level diffs we'll pull in `diff`.
 */
function unifiedDiff(a: string, b: string, path: string): string {
  if (a === b) return "";
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const ops = lcsDiff(aLines, bLines);
  const body: string[] = [];
  for (const op of ops) {
    if (op.kind === "eq")  body.push(" " + op.line);
    if (op.kind === "del") body.push("-" + op.line);
    if (op.kind === "add") body.push("+" + op.line);
  }
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${aLines.length} +1,${bLines.length} @@\n` +
         body.join("\n") + "\n";
}

type DiffOp = { kind: "eq" | "del" | "add"; line: string };
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;
  // LCS length table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j])                    { ops.push({ kind: "eq",  line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: "del", line: a[i] }); i++; }
    else                                   { ops.push({ kind: "add", line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ kind: "del", line: a[i++] }); }
  while (j < m) { ops.push({ kind: "add", line: b[j++] }); }
  return ops;
}

type PreEntry = { hash: string; text: string | null };

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

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

  async capturePost(sessionId: string, toolCallId: string, toolName: string, paths: string[]): Promise<EffectRecord> {
    const orderedPaths = normalizePaths(paths);
    const preHashes: Record<string, string> = {};
    const postHashes: Record<string, string> = {};
    const diffs: string[] = [];
    let binaryChanged = false;

    for (const p of orderedPaths) {
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
      sessionId,
      toolName,
      paths: orderedPaths,
      preHashes,
      postHashes,
      unifiedDiff: diffs.join("\n"),
      binaryChanged,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Factory that hands out per-call scopes. The old `EffectRecorder` API is
 * kept for back-compat (golden path + tests) but `snapshotPre`/`capturePost`
 * now go through an internal scope keyed by toolCallId, so concurrent calls
 * to the same path are correctly isolated.
 */
export async function appendEffectRecord(path: string, record: EffectRecord): Promise<void> {
  const parsed = EffectRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "effect record invalid", { issues: parsed.error.issues });
  }

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(parsed.data) + "\n", "utf8");
}

export async function readEffectLog(path: string): Promise<EffectRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "failed to read effect log", {
      path,
      cause: String(error),
    });
  }

  const lines = raw.split("\n").filter(Boolean);
  return lines.map((line, index) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "failed to parse effect log json", {
        path,
        line: index + 1,
        cause: String(error),
      });
    }

    try {
      return parseOrThrow(EffectRecordSchema, parsedJson, `effect line ${index + 1}`);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "effect log schema invalid", {
        path,
        line: index + 1,
        cause: String(error),
      });
    }
  });
}

export function renderWhatChanged(records: EffectRecord[]): string {
  const out: string[] = [];
  for (const rec of records) {
    out.push(`# ${rec.toolName} (${rec.toolCallId})`);
    for (const p of rec.paths) {
      out.push(`  ${p}  ${rec.preHashes[p]?.slice(0, 14)} -> ${rec.postHashes[p]?.slice(0, 14)}`);
    }
    if (rec.unifiedDiff) out.push(rec.unifiedDiff);
  }
  return out.join("\n");
}

export class EffectRecorder {
  private scopes = new Map<string, EffectScope>();

  scope(): EffectScope { return new EffectScope(); }

  /** Back-compat: sequential single-call API. */
  async snapshotPre(paths: string[], toolCallId = "__default__"): Promise<void> {
    let s = this.scopes.get(toolCallId);
    if (!s) { s = new EffectScope(); this.scopes.set(toolCallId, s); }
    await s.snapshotPre(normalizePaths(paths));
  }

  async capturePost(sessionId: string, toolCallId: string, toolName: string, paths: string[]): Promise<EffectRecord> {
    const s = this.scopes.get(toolCallId) ?? this.scopes.get("__default__") ?? new EffectScope();
    const rec = await s.capturePost(sessionId, toolCallId, toolName, paths);
    this.scopes.delete(toolCallId);
    return rec;
  }
}
