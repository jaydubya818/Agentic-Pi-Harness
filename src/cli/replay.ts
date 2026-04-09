import { readTape, verifyTape } from "../replay/recorder.js";
import { TapeRecord } from "../schemas/index.js";

function renderRecord(record: TapeRecord, index: number): string {
  if (record.type === "header") {
    return `# header session=${record.sessionId} policy=${record.policyDigest}`;
  }

  const event = record.event;
  switch (event.type) {
    case "message_start":
      return `[${index}] message_start`;
    case "text_delta":
      return `[${index}] text: ${JSON.stringify(event.text)}`;
    case "tool_use":
      return `[${index}] tool_use ${event.name}#${event.id} ${JSON.stringify(event.input)}`;
    case "tool_result":
      return `[${index}] tool_result #${event.id} ${event.isError ? "ERR " : ""}${event.output.slice(0, 80)}`;
    case "message_stop":
      return `[${index}] message_stop (${event.stopReason})`;
  }
}

/**
 * `pi-harness replay <tape.jsonl>` — verifies the hash chain, then pretty-
 * prints each event in order. Exits non-zero if the tape is corrupt so this
 * doubles as a CI guard.
 */
export async function replayTape(path: string): Promise<number> {
  const verification = await verifyTape(path);
  if (!verification.ok) {
    console.error(`FAIL: ${verification.error}`);
    return 1;
  }

  const records = await readTape(path);
  records.forEach((record, index) => {
    console.log(renderRecord(record, index));
  });
  console.log(`ok ${verification.records} records digest=${verification.digest}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tapePath = process.argv[2];
  if (!tapePath) {
    console.error("usage: replay <tape.jsonl>");
    process.exit(2);
  }
  replayTape(tapePath).then((code) => process.exit(code));
}
