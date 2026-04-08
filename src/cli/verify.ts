import { readFile } from "node:fs/promises";
import { TapeRecordSchema } from "../schemas/index.js";
import { canonicalize, sha256Hex } from "../schemas/canonical.js";

export interface VerifyResult { ok: boolean; records: number; error?: string; digest?: string; }

export async function verifyTape(path: string): Promise<VerifyResult> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let prevHash = "0".repeat(64);
  let last = prevHash;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[i]); }
    catch (e) { return { ok: false, records: i, error: `line ${i + 1}: invalid json` }; }
    const r = TapeRecordSchema.safeParse(parsed);
    if (!r.success) return { ok: false, records: i, error: `line ${i + 1}: schema: ${r.error.message}` };
    const rec = r.data;
    if (rec.prevHash !== prevHash) return { ok: false, records: i, error: `line ${i + 1}: prevHash mismatch` };
    const { recordHash, ...rest } = rec as any;
    const expected = "sha256:" + sha256Hex(canonicalize(rest));
    if (expected !== recordHash) return { ok: false, records: i, error: `line ${i + 1}: recordHash mismatch` };
    prevHash = recordHash;
    last = recordHash;
  }
  return { ok: true, records: lines.length, digest: last };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2];
  if (!p) { console.error("usage: verify <tape.jsonl>"); process.exit(2); }
  verifyTape(p).then((r) => {
    if (r.ok) { console.log(`ok ${r.records} records digest=${r.digest}`); process.exit(0); }
    console.error(`FAIL: ${r.error}`); process.exit(1);
  });
}
