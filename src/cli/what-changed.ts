import { readFile } from "node:fs/promises";
import { EffectRecordSchema } from "../schemas/index.js";

export async function whatChanged(effectLog: string): Promise<string> {
  const raw = await readFile(effectLog, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const out: string[] = [];
  for (const l of lines) {
    const rec = EffectRecordSchema.parse(JSON.parse(l));
    out.push(`# ${rec.toolName} (${rec.toolCallId}) rollback=${rec.rollbackConfidence}`);
    for (const p of rec.paths) out.push(`  ${p}  ${rec.preHashes[p]?.slice(0, 14)} -> ${rec.postHashes[p]?.slice(0, 14)}`);
    if (rec.unifiedDiff) out.push(rec.unifiedDiff);
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  whatChanged(process.argv[2]).then((s) => console.log(s));
}
