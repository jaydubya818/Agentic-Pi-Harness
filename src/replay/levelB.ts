import { readFile } from "node:fs/promises";
import { EffectRecordSchema, EffectRecord } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

/**
 * Level-B replay determinism: compare a recorded effect log against a fresh
 * run's effect log. Two logs are "effect-equivalent" iff they produce the
 * same (path, postHash) set for every mutating tool call, ignoring timestamps
 * and diff text (which may vary if the file was pre-existing with different
 * newlines, etc.).
 */

export interface EffectDrift {
  ok: boolean;
  missing: string[];           // paths present in recorded but not replayed
  extra: string[];             // paths present in replayed but not recorded
  hashMismatches: Array<{ path: string; recorded: string; replayed: string }>;
}

async function loadEffects(path: string): Promise<EffectRecord[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => {
    const r = EffectRecordSchema.safeParse(JSON.parse(l));
    if (!r.success) throw new PiHarnessError("E_SCHEMA_PARSE", "effect log invalid", { issues: r.error.issues });
    return r.data;
  });
}

function postSet(es: EffectRecord[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of es) for (const [p, h] of Object.entries(e.postHashes)) m.set(p, h);
  return m;
}

export async function diffEffectLogs(recordedPath: string, replayedPath: string): Promise<EffectDrift> {
  const a = postSet(await loadEffects(recordedPath));
  const b = postSet(await loadEffects(replayedPath));
  const missing: string[] = [];
  const extra: string[] = [];
  const hashMismatches: EffectDrift["hashMismatches"] = [];
  for (const [p, h] of a) {
    if (!b.has(p)) missing.push(p);
    else if (b.get(p) !== h) hashMismatches.push({ path: p, recorded: h, replayed: b.get(p)! });
  }
  for (const p of b.keys()) if (!a.has(p)) extra.push(p);
  return { ok: missing.length + extra.length + hashMismatches.length === 0, missing, extra, hashMismatches };
}
