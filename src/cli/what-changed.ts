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
  whatChanged(effectLogPath).then(
    (s) => console.log(s),
    (error) => {
      // Match the replay/verify CLI contract: clean FAIL line + exit 1
      // instead of an unhandled-rejection stack trace.
      console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
