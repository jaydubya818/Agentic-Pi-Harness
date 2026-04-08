import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StreamEvent, TapeRecord, TapeHeaderSchema, TapeEventRecordSchema } from "../schemas/index.js";
import { canonicalize, sha256Hex } from "../schemas/canonical.js";
import { PiHarnessError } from "../errors.js";

const ZERO = "0".repeat(64);

export class ReplayRecorder {
  private seq = 0;
  private prevHash = ZERO;

  constructor(private tapePath: string) {}

  private hashRecord(rec: Omit<TapeRecord, "recordHash">): string {
    return "sha256:" + sha256Hex(canonicalize(rec));
  }

  async writeHeader(meta: {
    sessionId: string;
    loopGitSha: string;
    policyDigest: string;
    costTableVersion: string;
  }): Promise<void> {
    await mkdir(dirname(this.tapePath), { recursive: true });
    const base = {
      type: "header" as const,
      schemaVersion: 1 as const,
      sessionId: meta.sessionId,
      createdAt: new Date().toISOString(),
      loopGitSha: meta.loopGitSha,
      policyDigest: meta.policyDigest,
      costTableVersion: meta.costTableVersion,
      prevHash: this.prevHash,
    };
    const recordHash = this.hashRecord(base);
    const rec = { ...base, recordHash };
    TapeHeaderSchema.parse(rec);
    await appendFile(this.tapePath, JSON.stringify(rec) + "\n");
    this.prevHash = recordHash;
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
    const recordHash = this.hashRecord(base);
    const rec = { ...base, recordHash };
    const r = TapeEventRecordSchema.safeParse(rec);
    if (!r.success) throw new PiHarnessError("E_TAPE_HASH", "invalid tape event record", { issues: r.error.issues });
    await appendFile(this.tapePath, JSON.stringify(rec) + "\n");
    this.prevHash = recordHash;
  }

  digest(): string {
    return this.prevHash;
  }
}
