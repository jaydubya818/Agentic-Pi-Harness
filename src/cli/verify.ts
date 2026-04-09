import { verifyTape } from "../replay/recorder.js";

export { verifyTape };

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2];
  if (!p) { console.error("usage: verify <tape.jsonl>"); process.exit(2); }
  verifyTape(p).then((r) => {
    if (r.ok) { console.log(`ok ${r.records} records digest=${r.digest}`); process.exit(0); }
    console.error(`FAIL: ${r.error}`); process.exit(1);
  });
}
