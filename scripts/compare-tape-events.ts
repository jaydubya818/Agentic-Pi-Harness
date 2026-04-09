#!/usr/bin/env tsx
import { readTape } from "../src/replay/recorder.js";
import { TapeRecord } from "../src/schemas/index.js";

function normalizeHeader(record: Extract<TapeRecord, { type: "header" }>) {
  return {
    type: record.type,
    schemaVersion: record.schemaVersion,
    loopGitSha: record.loopGitSha,
    policyDigest: record.policyDigest,
    costTableVersion: record.costTableVersion,
  };
}

function normalizeEventRecord(record: Extract<TapeRecord, { type: "event" }>) {
  return {
    type: record.type,
    schemaVersion: record.schemaVersion,
    seq: record.seq,
    event: record.event,
  };
}

async function main() {
  const [, , aPath, bPath] = process.argv;
  if (!aPath || !bPath) {
    console.error("usage: compare-tape-events.ts <a.jsonl> <b.jsonl>");
    process.exit(2);
  }

  const a = await readTape(aPath);
  const b = await readTape(bPath);

  if (a.length === 0 || b.length === 0) {
    console.error("drift: one or both tapes are empty");
    process.exit(1);
  }

  const aHeader = a[0];
  const bHeader = b[0];
  if (aHeader.type !== "header" || bHeader.type !== "header") {
    console.error("drift: both tapes must begin with a header record");
    process.exit(1);
  }

  const aHeaderSig = JSON.stringify(normalizeHeader(aHeader));
  const bHeaderSig = JSON.stringify(normalizeHeader(bHeader));
  if (aHeaderSig !== bHeaderSig) {
    console.error("drift: tape headers diverge");
    console.error("a:", aHeaderSig);
    console.error("b:", bHeaderSig);
    process.exit(1);
  }

  const aEvents = a.slice(1).map((record) => {
    if (record.type !== "event") {
      throw new Error("unexpected non-event record after header in first tape");
    }
    return normalizeEventRecord(record);
  });
  const bEvents = b.slice(1).map((record) => {
    if (record.type !== "event") {
      throw new Error("unexpected non-event record after header in second tape");
    }
    return normalizeEventRecord(record);
  });

  if (aEvents.length !== bEvents.length) {
    console.error(`drift: event record count ${aEvents.length} vs ${bEvents.length}`);
    process.exit(1);
  }

  for (let i = 0; i < aEvents.length; i++) {
    const left = JSON.stringify(aEvents[i]);
    const right = JSON.stringify(bEvents[i]);
    if (left !== right) {
      console.error(`drift: event record ${i + 1} diverges`);
      console.error("a:", left);
      console.error("b:", right);
      process.exit(1);
    }
  }

  console.log(`tapes match: ${aEvents.length} event records`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
