import { appendFile, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export class HermesBridgeStateStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir(), { recursive: true });
    await mkdir(this.runsDir(), { recursive: true });
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
    await safeWriteJsonUnique(this.runPath(record.accepted.execution_id), serializeRun(record));
  }

  async appendRunEvent(executionId: string, event: BridgeEventRecord): Promise<void> {
    await this.init();
    await mkdir(this.runDir(executionId), { recursive: true });
    await appendFile(this.eventsPath(executionId), JSON.stringify(parseBridgeEvent(event)) + "\n", "utf8");
  }

  async appendPreflightDenial(record: BridgePreflightDenialRecord): Promise<void> {
    await this.init();
    await appendFile(this.preflightDenialsPath(), JSON.stringify(record) + "\n", "utf8");
  }

  async loadPreflightDenials(): Promise<BridgePreflightDenialRecord[]> {
    try {
      const raw = await readFile(this.preflightDenialsPath(), "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as BridgePreflightDenialRecord);
    } catch {
      return [];
    }
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
    return sessions;
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
    return runs;
  }

  private async loadRunEvents(executionId: string): Promise<BridgeEventRecord[]> {
    try {
      const raw = await readFile(this.eventsPath(executionId), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => parseBridgeEvent(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  private sessionsDir(): string {
    return join(this.root, "sessions");
  }

  private runsDir(): string {
    return join(this.root, "runs");
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.json`);
  }

  private runDir(executionId: string): string {
    return join(this.runsDir(), executionId);
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

function serializeRun(record: BridgeStateRunRecord): PersistedBridgeRunRecord {
  return {
    accepted: HermesTaskAcceptedSchema.parse(record.accepted),
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

async function safeWriteJsonUnique(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(value, null, 2) + "\n";
  await writeFile(tmp, json, "utf8");
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

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
