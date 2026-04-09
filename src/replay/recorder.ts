import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOrThrow, StreamEvent, TapeEventRecordSchema, TapeHeaderSchema, TapeRecord, TapeRecordSchema } from "../schemas/index.js";
import { framedCanonical, sha256Hex } from "../schemas/canonical.js";
import { PiHarnessError } from "../errors.js";

const ZERO = "0".repeat(64);

export interface ReplayHeaderInput {
  sessionId: string;
  loopGitSha: string;
  policyDigest: string;
  costTableVersion: string;
  createdAt?: string;
}

export interface VerifyResult {
  ok: boolean;
  records: number;
  error?: string;
  digest?: string;
}

async function safeWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, text, "utf8");

  const fileHandle = await open(tmp, "r");
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tmp, path);

  const dirHandle = await open(dirname(path), "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

function hashRecord(record: Omit<TapeRecord, "recordHash">): string {
  return "sha256:" + sha256Hex(framedCanonical("pi-tape-v1", record));
}

function serializeTape(records: TapeRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function verifyRecordChain(record: TapeRecord, expectedPrevHash: string, lineNumber: number): { ok: true; digest: string } | { ok: false; error: string } {
  if (record.prevHash !== expectedPrevHash) {
    return { ok: false, error: `line ${lineNumber}: prevHash mismatch` };
  }

  const { recordHash, ...rest } = record;
  const expectedHash = hashRecord(rest as Omit<TapeRecord, "recordHash">);
  if (expectedHash !== recordHash) {
    return { ok: false, error: `line ${lineNumber}: recordHash mismatch` };
  }

  return { ok: true, digest: recordHash };
}

export async function readTape(path: string): Promise<TapeRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "failed to read tape", {
      path,
      cause: String(error),
    });
  }

  const lines = raw.split("\n").filter(Boolean);
  const records: TapeRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lines[i]);
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "failed to parse tape json", {
        path,
        line: i + 1,
        cause: String(error),
      });
    }

    try {
      records.push(parseOrThrow(TapeRecordSchema, parsedJson, `tape line ${i + 1}`));
    } catch (error) {
      throw new PiHarnessError("E_SCHEMA_PARSE", "tape schema invalid", {
        path,
        line: i + 1,
        cause: String(error),
      });
    }
  }

  return records;
}

export async function verifyTape(path: string): Promise<VerifyResult> {
  try {
    const records = await readTape(path);
    let prevHash = ZERO;
    let lastDigest = prevHash;

    for (let i = 0; i < records.length; i++) {
      const result = verifyRecordChain(records[i], prevHash, i + 1);
      if (!result.ok) {
        return { ok: false, records: i, error: result.error };
      }
      prevHash = result.digest;
      lastDigest = result.digest;
    }

    return { ok: true, records: records.length, digest: lastDigest };
  } catch (error) {
    if (error instanceof PiHarnessError) {
      return { ok: false, records: 0, error: error.message };
    }
    return { ok: false, records: 0, error: String(error) };
  }
}

export class ReplayRecorder {
  private seq = 0;
  private prevHash = ZERO;
  private records: TapeRecord[] = [];

  constructor(private tapePath: string) {}

  async writeHeader(meta: ReplayHeaderInput): Promise<void> {
    const base = {
      type: "header" as const,
      schemaVersion: 1 as const,
      sessionId: meta.sessionId,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      loopGitSha: meta.loopGitSha,
      policyDigest: meta.policyDigest,
      costTableVersion: meta.costTableVersion,
      prevHash: this.prevHash,
    };
    const recordHash = hashRecord(base);
    const record = parseOrThrow(TapeHeaderSchema, { ...base, recordHash }, "tape header");
    this.records = [record];
    this.prevHash = recordHash;
    this.seq = 0;
    await safeWriteText(this.tapePath, serializeTape(this.records));
  }

  async writeEvent(event: StreamEvent): Promise<void> {
    this.seq += 1;
    const base = {
      type: "event" as const,
      schemaVersion: 1 as const,
      seq: this.seq,
      event,
      prevHash: this.prevHash,
    };
    const recordHash = hashRecord(base);
    const record = TapeEventRecordSchema.safeParse({ ...base, recordHash });
    if (!record.success) {
      throw new PiHarnessError("E_TAPE_HASH", "invalid tape event record", { issues: record.error.issues });
    }
    this.records.push(record.data);
    this.prevHash = recordHash;
    await safeWriteText(this.tapePath, serializeTape(this.records));
  }

  digest(): string {
    return this.prevHash;
  }
}
