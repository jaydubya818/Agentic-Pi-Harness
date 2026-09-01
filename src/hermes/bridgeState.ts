import { appendFile, mkdir, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareCodeUnits } from "../schemas/canonical.js";
import { safeWriteJson } from "../session/provenance.js";
import {
  HermesSessionSchema,
  HermesTaskAcceptedSchema,
  HermesTaskEventSchema,
  HermesTaskRequestSchema,
  HermesTaskResultSchema,
  PiHermesResultEnvelopeV2Schema,
  PiHermesStructuredEventV2Schema,
  PiHermesTaskEnvelopeV2Schema,
  type HermesSession,
  type HermesTaskAccepted,
  type HermesTaskEvent,
  type HermesTaskRequest,
  type HermesTaskResult,
  type PiHermesResultEnvelopeV2,
  type PiHermesStructuredEventV2,
  type PiHermesTaskEnvelopeV2,
} from "./index.js";

export type BridgeEventRecord = HermesTaskEvent | PiHermesStructuredEventV2;

export interface BridgeStateRunRecord {
  accepted: HermesTaskAccepted;
  /**
   * When the bridge accepted this run, stamped once at acceptance and never
   * rewritten. `HermesTaskAccepted` carries no timestamp of its own, so
   * without this a restored run has no acceptance time at all and `loadRuns`
   * can only order by the owning session's `created_at` — a proxy that ties
   * for every run on one session. Optional because run records persisted
   * before this field existed do not have it; see `loadRuns`.
   */
  acceptedAt?: string;
  request: HermesTaskRequest;
  status: HermesTaskResult["status"];
  state?: string;
  session: HermesSession;
  events: BridgeEventRecord[];
  result: HermesTaskResult | null;
  error: string | null;
  v2Task?: PiHermesTaskEnvelopeV2 | null;
  v2Result?: PiHermesResultEnvelopeV2 | null;
  failureClass?: string | null;
}

interface PersistedBridgeRunRecord {
  accepted: HermesTaskAccepted;
  /** Snake-case on disk to match every other persisted field. */
  accepted_at?: string | null;
  request: HermesTaskRequest;
  status: HermesTaskResult["status"];
  state?: string;
  session: HermesSession;
  result: HermesTaskResult | null;
  error: string | null;
  v2Task?: PiHermesTaskEnvelopeV2 | null;
  v2Result?: PiHermesResultEnvelopeV2 | null;
  failureClass?: string | null;
}

export interface BridgePreflightDenialRecord {
  at: string;
  code: string;
  message: string;
  request_id?: string | null;
  run_id?: string | null;
  mission_id?: string | null;
  session_id?: string | null;
  execution_id?: string | null;
  detail?: unknown;
}

export interface BridgeStateSnapshot {
  sessions: HermesSession[];
  runs: BridgeStateRunRecord[];
}

/**
 * Session and execution ids are used as filesystem path segments under the
 * bridge state root. Reject anything that could traverse out of it.
 */
export function assertSafeStateIdSegment(value: string, label: string): string {
  if (value === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} is not a safe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

export class HermesBridgeStateStore {
  readonly root: string;
  private initPromise: Promise<void> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    // Memoized: every persist/append funnels through init(), so the two
    // skeleton mkdirs otherwise re-run for every worker output line on the
    // per-event hot path. A failed init is not cached — a later call must
    // retry instead of replaying the stale rejection forever.
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await mkdir(this.sessionsDir(), { recursive: true });
        await mkdir(this.runsDir(), { recursive: true });
      })();
      this.initPromise.catch(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  async load(): Promise<BridgeStateSnapshot> {
    await this.init();
    return {
      sessions: await this.loadSessions(),
      runs: await this.loadRuns(),
    };
  }

  async persistSession(session: HermesSession): Promise<void> {
    await this.init();
    const parsed = HermesSessionSchema.parse(session);
    await safeWriteJson(this.sessionPath(parsed.session_id), parsed);
  }

  async persistRun(record: BridgeStateRunRecord): Promise<void> {
    await this.init();
    await mkdir(this.runDir(record.accepted.execution_id), { recursive: true });
    await safeWriteJson(this.runPath(record.accepted.execution_id), serializeRun(record));
  }

  async appendRunEvent(executionId: string, event: BridgeEventRecord): Promise<void> {
    await this.init();
    await mkdir(this.runDir(executionId), { recursive: true });
    await appendFile(this.eventsPath(executionId), JSON.stringify(parseBridgeEvent(event)) + "\n", "utf8");
  }

  async appendPreflightDenial(record: BridgePreflightDenialRecord): Promise<void> {
    // mkdir directly rather than the memoized init(): the denial log lives
    // at the state root, and an externally wiped root must be recreated
    // here the way persistRun/appendRunEvent recreate their run dirs.
    await mkdir(this.root, { recursive: true });
    await appendFile(this.preflightDenialsPath(), JSON.stringify(record) + "\n", "utf8");
  }

  /**
   * The denial log is append-only and unbounded on a long-lived bridge, so
   * the whole-file read behind every `GET /preflight-denials?limit=N` grew
   * without bound even though the caller only wanted the tail. With a limit,
   * read backwards from the end until enough lines are in hand.
   */
  async loadPreflightDenials(limit?: number): Promise<BridgePreflightDenialRecord[]> {
    let raw: string;
    try {
      raw = limit === undefined
        ? await readFile(this.preflightDenialsPath(), "utf8")
        : await readTailLines(this.preflightDenialsPath(), limit);
    } catch {
      return [];
    }
    const records: BridgePreflightDenialRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as BridgePreflightDenialRecord);
      } catch {
        // One torn/corrupt line (e.g. a crash mid-append) must not hide
        // every other recorded denial.
      }
    }
    return records;
  }

  private async loadSessions(): Promise<HermesSession[]> {
    const sessions: HermesSession[] = [];
    for (const entry of await safeReadDir(this.sessionsDir())) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.sessionsDir(), entry), "utf8"));
        sessions.push(HermesSessionSchema.parse(raw));
      } catch {
        // skip invalid persisted session state
      }
    }
    // `readdir` order is filesystem-defined, so restoring in it made the
    // rebuilt Map's insertion order arbitrary -- and both `GET /sessions` and
    // `GET /runs` document their `?limit=N` as tailing the *most recent*
    // records by leaning on that insertion order. After a restart the tail
    // was therefore an arbitrary N, not the newest N. `created_at` is
    // persisted on every session, so restore in creation order; session_id
    // breaks ties so the result is total.
    return sessions.sort((a, b) =>
      compareCodeUnits(a.created_at, b.created_at) || compareCodeUnits(a.session_id, b.session_id));
  }

  private async loadRuns(): Promise<BridgeStateRunRecord[]> {
    const runs: BridgeStateRunRecord[] = [];
    for (const entry of await safeReadDir(this.runsDir())) {
      const runPath = join(this.runsDir(), entry, "run.json");
      try {
        const raw = JSON.parse(await readFile(runPath, "utf8")) as PersistedBridgeRunRecord;
        runs.push({
          ...parsePersistedRun(raw),
          events: await this.loadRunEvents(entry),
        });
      } catch {
        // skip invalid persisted run state
      }
    }
    // Same `readdir` problem as loadSessions. Runs persisted with an
    // `accepted_at` order by it, which is true acceptance order including for
    // two runs sharing one session — the case the session-created_at proxy
    // could never separate.
    //
    // Records written before `accepted_at` existed fall back to the owning
    // session's created_at, which is the ordering they already had. Mixing
    // the two keys is coherent rather than arbitrary: both are ISO-8601 UTC
    // strings and a run is always accepted at or after its session was
    // created, so a legacy run sorts no later than it did before. Ordering
    // between two runs is only sharpened, never inverted, by adding the
    // field. `execution_id` remains the total tie-break so the result is
    // identical on every host and across every restart.
    return runs.sort((a, b) =>
      compareCodeUnits(runOrderKey(a), runOrderKey(b))
      || compareCodeUnits(a.accepted.execution_id, b.accepted.execution_id));
  }

  private async loadRunEvents(executionId: string): Promise<BridgeEventRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath(executionId), "utf8");
    } catch {
      return [];
    }
    const events: BridgeEventRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        events.push(parseBridgeEvent(JSON.parse(line)));
      } catch {
        // One torn/corrupt line (e.g. a crash mid-append) must not drop
        // every other persisted event for the run.
      }
    }
    return events;
  }

  private sessionsDir(): string {
    return join(this.root, "sessions");
  }

  private runsDir(): string {
    return join(this.root, "runs");
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir(), `${assertSafeStateIdSegment(sessionId, "session_id")}.json`);
  }

  private runDir(executionId: string): string {
    return join(this.runsDir(), assertSafeStateIdSegment(executionId, "execution_id"));
  }

  private runPath(executionId: string): string {
    return join(this.runDir(executionId), "run.json");
  }

  private eventsPath(executionId: string): string {
    return join(this.runDir(executionId), "events.jsonl");
  }

  private preflightDenialsPath(): string {
    return join(this.root, "preflight-denials.jsonl");
  }
}


/** Starting window for a tail read, grown until it holds enough lines. */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Hard stop so a log with enormous single records cannot pull it all in. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Read enough of the end of a JSONL file to contain at least `minLines`
 * complete lines. Any partial line at the front of the window is dropped, so
 * a chunk boundary can never produce a torn record (or a split multi-byte
 * character, which always lands inside that discarded prefix).
 */
/**
 * read() is allowed to return short even on a regular file. A single call
 * that came up short left the rest of the window as its zero fill, which
 * decodes into NUL padding glued onto the newest record: the tail's last
 * line stops being valid JSON and the most recent denial silently vanishes
 * from the response. Loop until the window is full or EOF is reached.
 */
async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

async function readTailLines(path: string, minLines: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return "";
    let window = Math.min(size, TAIL_CHUNK_BYTES);
    for (;;) {
      const buffer = Buffer.alloc(window);
      const filled = await readFully(handle, buffer, size - window);
      const atStart = window >= size;
      const text = buffer.toString("utf8", 0, filled);
      const firstNewline = text.indexOf("\n");
      const complete = atStart ? text : (firstNewline === -1 ? "" : text.slice(firstNewline + 1));
      const lineCount = complete.split("\n").filter(Boolean).length;
      if (atStart || lineCount >= minLines || window >= MAX_TAIL_BYTES) return complete;
      window = Math.min(size, Math.max(window * 4, TAIL_CHUNK_BYTES));
    }
  } finally {
    await handle.close();
  }
}

/**
 * Primary sort key for restored runs: true acceptance time when the record
 * has one, the owning session's creation time for records written before
 * `accepted_at` existed.
 *
 * Both are normalized to the canonical `…T…:…:….sssZ` form first. The two
 * fields are produced by different call sites and a lexicographic compare of
 * ISO strings that disagree on sub-second precision is wrong, not merely
 * arbitrary: `"2026-08-02T00:00:00Z"` sorts *after* `"2026-08-02T00:00:00.500Z"`
 * because `"Z"` > `"."` in code-unit order, inverting two instants that are
 * half a second apart. An unparseable stamp falls back to its raw text, which
 * is still deterministic across hosts and restarts.
 */
function runOrderKey(record: BridgeStateRunRecord): string {
  const raw = record.acceptedAt ?? record.session.created_at;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : new Date(ms).toISOString();
}

function serializeRun(record: BridgeStateRunRecord): PersistedBridgeRunRecord {
  return {
    accepted: HermesTaskAcceptedSchema.parse(record.accepted),
    accepted_at: record.acceptedAt ?? null,
    request: HermesTaskRequestSchema.parse(record.request),
    status: record.status,
    state: record.state,
    session: HermesSessionSchema.parse(record.session),
    result: record.result ? HermesTaskResultSchema.parse(record.result) : null,
    error: record.error,
    v2Task: record.v2Task ? PiHermesTaskEnvelopeV2Schema.parse(record.v2Task) : null,
    v2Result: record.v2Result ? PiHermesResultEnvelopeV2Schema.parse(record.v2Result) : null,
    failureClass: record.failureClass ?? null,
  };
}

function parsePersistedRun(record: PersistedBridgeRunRecord): Omit<BridgeStateRunRecord, "events"> {
  return {
    accepted: HermesTaskAcceptedSchema.parse(record.accepted),
    acceptedAt: record.accepted_at ?? undefined,
    request: HermesTaskRequestSchema.parse(record.request),
    status: record.status,
    state: record.state,
    session: HermesSessionSchema.parse(record.session),
    result: record.result ? HermesTaskResultSchema.parse(record.result) : null,
    error: record.error,
    v2Task: record.v2Task ? PiHermesTaskEnvelopeV2Schema.parse(record.v2Task) : null,
    v2Result: record.v2Result ? PiHermesResultEnvelopeV2Schema.parse(record.v2Result) : null,
    failureClass: record.failureClass ?? null,
  };
}

function parseBridgeEvent(event: unknown): BridgeEventRecord {
  const v2 = PiHermesStructuredEventV2Schema.safeParse(event);
  if (v2.success) return v2.data;
  return HermesTaskEventSchema.parse(event);
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
