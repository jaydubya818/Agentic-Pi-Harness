import { readEffectLog, renderWhatChanged } from "../effect/recorder.js";

export async function whatChanged(effectLog: string): Promise<string> {
  const records = await readEffectLog(effectLog);
  return renderWhatChanged(records);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const effectLogPath = process.argv[2];
  if (!effectLogPath) {
    console.error("usage: what-changed <effects.jsonl>");
    process.exit(2);
  }
  whatChanged(effectLogPath).then((s) => console.log(s));
}
