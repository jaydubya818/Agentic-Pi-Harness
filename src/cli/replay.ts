import { readFile } from "node:fs/promises";
import { verifyTape } from "./verify.js";

/**
 * `pi-harness replay <tape.jsonl>` — verifies the hash chain, then pretty-
 * prints each event in order. Exits non-zero if the tape is corrupt so this
 * doubles as a CI guard.
 */
export async function replayTape(path: string): Promise<number> {
  const v = await verifyTape(path);
  if (!v.ok) {
    console.error(`FAIL: ${v.error}`);
    return 1;
  }
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    if (rec.type === "header") {
      console.log(`# header session=${rec.sessionId} policy=${rec.policyDigest}`);
      continue;
    }
    const e = rec.event;
    switch (e?.type) {
      case "message_start": console.log(`[${i}] message_start`); break;
      case "text_delta":    console.log(`[${i}] text: ${JSON.stringify(e.text)}`); break;
      case "tool_use":      console.log(`[${i}] tool_use ${e.name}#${e.id} ${JSON.stringify(e.input)}`); break;
      case "tool_result":   console.log(`[${i}] tool_result #${e.id} ${e.isError ? "ERR " : ""}${e.output.slice(0, 80)}`); break;
      case "message_stop":  console.log(`[${i}] message_stop (${e.stopReason})`); break;
      default:              console.log(`[${i}] ${JSON.stringify(e)}`);
    }
  }
  console.log(`ok ${v.records} records digest=${v.digest}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2];
  if (!p) { console.error("usage: replay <tape.jsonl>"); process.exit(2); }
  replayTape(p).then((code) => process.exit(code));
}
