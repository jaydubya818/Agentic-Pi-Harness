import { FileHandle, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOrThrow, StreamEvent, TapeEventRecordSchema, TapeHeaderSchema, TapeRecord, TapeRecordSchema } from "../schemas/index.js";
import { sha256HexFramed } from "../schemas/canonical.js";
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

/**
 * Initial crash-safe write for the tape header. Uses the classic write-to-tmp +
 * fsync + rename + fsync(dir) dance so a crash mid-init leaves no partial tape.
 * Only called once per session (for the header); subsequent events are appended
 * via an open file handle — see ReplayRecorder below.
 */
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
  return "sha256:" + sha256HexFramed("pi-tape-v1", record);
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

/**
 * Append-only, crash-safe JSONL tape writer.
 *
 * Design:
 *   - The header is committed via write-tmp + fsync + rename + fsync(dir) so
 *     the initial file exists atomically (this also satisfies any observer
 *     that scans the output dir expecting either "no file" or "valid file").
 *   - Subsequent events are appended to an open FileHandle in O_APPEND mode.
 *     POSIX guarantees that an O_APPEND write adjusts the offset and writes
 *     atomically with respect to other appenders, and we fsync after each
 *     append so the record is durable before writeEvent resolves.
 *   - In-memory `records[]` is retained for callers that want the full tape
 *     (e.g. replay/levelB), but the serialization hot-path no longer rewrites
 *     the entire file on every event (was O(N^2); now O(N)).
 *
 * Crash semantics:
 *   - A crash before fsync returns may lose the in-flight record entirely
 *     (acceptable — writeEvent had not resolved) or leave a torn last line.
 *     verifyTape already surfaces a torn final line as a clean
 *     E_SCHEMA_PARSE / hash-mismatch result, so the contract holds.
 */
export class ReplayRecorder {
  private seq = 0;
  private prevHash = ZERO;
  private records: TapeRecord[] = [];
  private handle: FileHandle | null = null;
  private closed = false;

  constructor(private tapePath: string) {}

  async writeHeader(meta: ReplayHeaderInput): Promise<void> {
    if (this.handle) {
      // Reinitialization — close the old handle first.
      await this.handle.close();
      this.handle = null;
    }
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
    // Atomically install the header file.
    await safeWriteText(this.tapePath, JSON.stringify(record) + "\n");
    // Then open in append mode for subsequent events.
    this.handle = await open(this.tapePath, "a");
    this.closed = false;
  }

  async writeEvent(event: StreamEvent): Promise<void> {
    if (!this.handle || this.closed) {
      throw new PiHarnessError("E_TAPE_HASH", "writeEvent before writeHeader or after close", {});
    }
    this.seq += 1;
    const base = {
      type: "event" as const,
      schemaVersion: 1 as const,
      seq: this.seq,
      event,
      prevHash: this.prevHash,
    };
    const recordHash = hashRecord(base);
    const parsed = TapeEventRecordSchema.safeParse({ ...base, recordHash });
    if (!parsed.success) {
      throw new PiHarnessError("E_TAPE_HASH", "invalid tape event record", { issues: parsed.error.issues });
    }
    const record = parsed.data;
    this.records.push(record);
    this.prevHash = recordHash;
    // Append + fsync. O_APPEND guarantees atomic-offset writes; fsync makes
    // the record durable before we resolve the promise.
    await this.handle.appendFile(JSON.stringify(record) + "\n", "utf8");
    await this.handle.sync();
  }

  digest(): string {
    return this.prevHash;
  }

  /**
   * Close the underlying file handle. Safe to call more than once. Callers who
   * don't explicitly close still get correct durability (each writeEvent
   * fsyncs), but closing avoids leaking the handle.
   */
  async close(): Promise<void> {
    if (this.handle && !this.closed) {
      this.closed = true;
      const h = this.handle;
      this.handle = null;
      await h.close();
    }
  }
}
