import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import { NoopLogger, type Logger } from "../obs/logger.js";
import { safeWriteJson } from "../session/provenance.js";
import {
  HermesArtifactSchema,
  HermesSessionSchema,
  HermesTaskAcceptedSchema,
  type HermesTaskAccepted,
  HermesTaskEvent,
  HermesTaskEventSchema,
  HermesTaskRequest,
  HermesTaskRequestSchema,
  HermesTaskResult,
  HermesTaskResultSchema,
  type HermesSession,
} from "./contracts.js";
import { detectHermesBinaryPath } from "./discovery.js";
import { spawnHermesTransport, type HermesTransport } from "./transport.js";

const StructuredWorkerResultSchema = z.object({
  summary: z.string().default(""),
  artifacts: z.array(HermesArtifactSchema).default([]),
  error: z.string().nullable().optional(),
});

export interface HermesAdapterOptions {
  command?: string;
  commandArgsPrefix?: string[];
  stateRoot?: string;
  preferTransport?: "pty" | "subprocess";
  source?: string;
  logger?: Logger;
  ptyCols?: number;
  ptyRows?: number;
}

interface ActiveExecution {
  request: HermesTaskRequest;
  executionId: string;
  runtimeDir: string;
  rawLogPath: string;
  eventLogPath: string;
  requestPath: string;
  resultPath: string;
  transport: HermesTransport | null;
  rawOutput: string;
  partialLine: string;
  sawOutput: boolean;
  intent: "interrupt" | "cancel" | null;
  timeoutError: string | null;
  timeoutHandle: NodeJS.Timeout | null;
  forceKillHandle: NodeJS.Timeout | null;
  completion: Promise<HermesTaskResult>;
  resolve: (result: HermesTaskResult) => void;
  reject: (error: unknown) => void;
}

interface StoredSession {
  record: HermesSession;
  env: NodeJS.ProcessEnv;
  profile: string | null;
  events: HermesTaskEvent[];
  waiters: Array<() => void>;
  active: ActiveExecution | null;
  lastResult: HermesTaskResult | null;
}

export interface StartHermesSessionOptions {
  env?: NodeJS.ProcessEnv;
  profile?: string;
}

export interface HermesAdapterSession extends HermesSession {}

export class HermesAdapter {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly command: string;
  private readonly commandArgsPrefix: string[];
  private readonly stateRoot: string;
  private readonly preferTransport: "pty" | "subprocess";
  private readonly source: string;
  private readonly logger: Logger;
  private readonly ptyCols: number;
  private readonly ptyRows: number;

  constructor(options: HermesAdapterOptions = {}) {
    this.command = options.command ?? detectHermesBinaryPath(process.env) ?? process.env.HERMES_COMMAND ?? "hermes";
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
    this.stateRoot = resolve(options.stateRoot ?? join(tmpdir(), "pi-hermes-adapter"));
    this.preferTransport = options.preferTransport ?? "pty";
    this.source = options.source ?? "tool";
    this.logger = options.logger ?? new NoopLogger();
    this.ptyCols = options.ptyCols ?? 120;
    this.ptyRows = options.ptyRows ?? 30;
  }

  async start_session(workdir: string, options: StartHermesSessionOptions = {}): Promise<HermesAdapterSession> {
    const sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimeDir = resolve(join(this.stateRoot, sessionId));
    const record = HermesSessionSchema.parse({
      session_id: sessionId,
      workdir: resolve(workdir),
      profile: options.profile ?? null,
      runtime_dir: runtimeDir,
      hermes_session_id: null,
      status: "idle",
      created_at: new Date().toISOString(),
    });

    await mkdir(runtimeDir, { recursive: true });
    await safeWriteJson(join(runtimeDir, "session.json"), record);

    const stored: StoredSession = {
      record,
      env: { ...process.env, ...(options.env ?? {}) },
      profile: options.profile ?? null,
      events: [],
      waiters: [],
      active: null,
      lastResult: null,
    };

    this.sessions.set(record.session_id, stored);
    this.logger.child({ sessionId: record.session_id }).log("info", "hermes.session.started", {
      workdir: record.workdir,
      runtimeDir: record.runtime_dir,
      profile: record.profile,
    });

    return record;
  }

  async send_task(sessionId: string, payload: HermesTaskRequest): Promise<HermesTaskAccepted> {
    const session = this.requireSession(sessionId);
    const request = HermesTaskRequestSchema.parse(payload);
    if (request.session_id !== sessionId) {
      throw new Error(`request.session_id mismatch: expected ${sessionId}, got ${request.session_id}`);
    }
    if (session.active) {
      throw new Error(`session ${sessionId} already has an active Hermes execution`);
    }

    const executionId = request.execution_id ?? `exec_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimeDir = resolve(join(request.output_dir, ".pi-hermes"));
    await mkdir(runtimeDir, { recursive: true });

    const requestPath = join(runtimeDir, "request.json");
    const resultPath = join(runtimeDir, "result.json");
    const rawLogPath = join(runtimeDir, "hermes.raw.log");
    const eventLogPath = join(runtimeDir, "events.jsonl");
    await safeWriteJson(requestPath, request);

    let resolveCompletion!: (result: HermesTaskResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<HermesTaskResult>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });

    const active: ActiveExecution = {
      request,
      executionId,
      runtimeDir,
      rawLogPath,
      eventLogPath,
      requestPath,
      resultPath,
      transport: null,
      rawOutput: "",
      partialLine: "",
      sawOutput: false,
      intent: null,
      timeoutError: null,
      timeoutHandle: null,
      forceKillHandle: null,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };

    session.active = active;
    session.record.status = "running";
    await safeWriteJson(join(session.record.runtime_dir, "session.json"), session.record);

    const commandArgs = this.buildCommandArgs(session, request, executionId);
    const env = this.buildEnv(session, request, executionId);
    const commandPreview = [this.command, ...commandArgs].join(" ");
    await this.pushEvent(session, {
      type: "task.started",
      session_id: sessionId,
      execution_id: executionId,
      at: new Date().toISOString(),
      data: {
        request_id: request.request_id,
        command: commandPreview,
        runtime_dir: runtimeDir,
      },
    });

    this.logger.child({ sessionId, executionId }).log("info", "hermes.task.spawn", {
      workdir: request.workdir,
      outputDir: request.output_dir,
      command: commandPreview,
    });

    try {
      const transport = spawnHermesTransport({
        command: this.command,
        args: commandArgs,
        cwd: request.workdir,
        env,
        prefer: this.preferTransport,
        cols: this.ptyCols,
        rows: this.ptyRows,
      });
      active.transport = transport;

      await this.pushEvent(session, {
        type: "task.progress",
        session_id: sessionId,
        execution_id: executionId,
        at: new Date().toISOString(),
        data: {
          status: "running",
          transport: transport.mode,
          transport_backend: transport.backend,
          pid: transport.pid,
        },
      });

      transport.onOutput((chunk, stream) => {
        void this.handleOutput(session, active, chunk, stream);
      });
      transport.onExit((event) => {
        void this.handleExit(session, active, event.exitCode, event.signal);
      });

      active.timeoutHandle = setTimeout(() => {
        active.timeoutError = `Timed out after ${request.timeout_seconds} seconds`;
        this.logger.child({ sessionId, executionId }).log("warn", "hermes.task.timeout", {
          timeoutSeconds: request.timeout_seconds,
        });
        this.terminateTransport(active, "SIGTERM");
        active.forceKillHandle = setTimeout(() => {
          this.terminateTransport(active, "SIGKILL");
        }, 5000);
      }, request.timeout_seconds * 1000);

      return HermesTaskAcceptedSchema.parse({
        request_id: request.request_id,
        session_id: sessionId,
        execution_id: executionId,
        status: "accepted",
      });
    } catch (error) {
      const result = HermesTaskResultSchema.parse({
        execution_id: executionId,
        status: "failed",
        summary: "",
        artifacts: [],
        error: error instanceof Error ? error.message : String(error),
        structured_output: false,
      });
      await safeWriteJson(resultPath, result);
      session.active = null;
      session.lastResult = result;
      session.record.status = "idle";
      await safeWriteJson(join(session.record.runtime_dir, "session.json"), session.record);
      active.reject(error);
      throw error;
    }
  }

  async *read_events(sessionId: string, executionId?: string): AsyncGenerator<HermesTaskEvent> {
    const session = this.requireSession(sessionId);
    let cursor = 0;
    let sawExecution = false;
    while (true) {
      while (cursor < session.events.length) {
        const event = session.events[cursor++];
        if (executionId && event.execution_id !== executionId) continue;
        sawExecution = true;
        yield event;
        if (executionId && isTerminalEventType(event.type)) return;
      }
      const lastEvent = executionId
        ? [...session.events].reverse().find((event) => event.execution_id === executionId)
        : session.events[session.events.length - 1];
      if (sawExecution && !session.active && isTerminalEventType(lastEvent?.type)) return;
      await new Promise<void>((resolvePromise) => {
        session.waiters.push(resolvePromise);
      });
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.active) return;
    session.active.intent = "interrupt";
    this.terminateTransport(session.active, "SIGINT");
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.active) return;
    session.active.intent = "cancel";
    this.terminateTransport(session.active, "SIGTERM");
    session.active.forceKillHandle = setTimeout(() => {
      this.terminateTransport(session.active, "SIGKILL");
    }, 3000);
  }

  async collect_result(sessionId: string): Promise<HermesTaskResult> {
    const session = this.requireSession(sessionId);
    if (session.active) return session.active.completion;
    if (session.lastResult) return session.lastResult;
    throw new Error(`session ${sessionId} has no Hermes result to collect`);
  }

  async close_session(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.active) {
      await this.cancel(sessionId);
      try {
        await session.active.completion;
      } catch {
        // swallow — session close is best-effort cleanup
      }
    }
    session.record.status = "closed";
    await safeWriteJson(join(session.record.runtime_dir, "session.json"), session.record);
    const waiters = session.waiters.splice(0, session.waiters.length);
    for (const waiter of waiters) waiter();
    this.sessions.delete(sessionId);
  }

  private buildCommandArgs(session: StoredSession, request: HermesTaskRequest, executionId: string): string[] {
    const prompt = this.buildPrompt(request, executionId);
    const args = [...this.commandArgsPrefix];
    if (session.profile) args.push("--profile", session.profile);
    args.push("chat", "-Q", "-q", prompt, "--source", this.source);
    if (session.record.hermes_session_id) {
      args.push("--resume", session.record.hermes_session_id);
    }
    return args;
  }

  private buildEnv(session: StoredSession, request: HermesTaskRequest, executionId: string): NodeJS.ProcessEnv {
    return {
      ...session.env,
      PI_HERMES_REQUEST_ID: request.request_id,
      PI_HERMES_SESSION_ID: request.session_id,
      PI_HERMES_EXECUTION_ID: executionId,
      PI_HERMES_OUTPUT_DIR: request.output_dir,
      PI_HERMES_ALLOWED_TOOLS: request.allowed_tools.join(","),
      PI_HERMES_ALLOWED_ACTIONS: request.allowed_actions.join(","),
      PI_HERMES_TIMEOUT_SECONDS: String(request.timeout_seconds),
      PI_HERMES_MISSION_ID: request.metadata.mission_id ?? "",
      PI_HERMES_RUN_ID: request.metadata.run_id ?? "",
      PI_HERMES_STEP_ID: request.metadata.step_id ?? "",
    };
  }

  private buildPrompt(request: HermesTaskRequest, executionId: string): string {
    const metadataLines = [
      `request_id: ${request.request_id}`,
      `session_id: ${request.session_id}`,
      `execution_id: ${executionId}`,
      `mission_id: ${request.metadata.mission_id ?? ""}`,
      `run_id: ${request.metadata.run_id ?? ""}`,
      `step_id: ${request.metadata.step_id ?? ""}`,
    ];

    return [
      "You are Hermes running as a supervised worker for the Pi harness.",
      "Operate only through your normal CLI capabilities. Do not assume any direct integration with Pi internals.",
      "",
      "Task objective:",
      request.objective,
      "",
      "Execution envelope:",
      `- Workdir: ${request.workdir}`,
      `- Output dir for artifacts: ${request.output_dir}`,
      `- Allowed tools: ${request.allowed_tools.join(", ") || "(advisory only)"}`,
      `- Allowed actions: ${request.allowed_actions.join(", ") || "(advisory only)"}`,
      `- Timeout budget: ${request.timeout_seconds} seconds`,
      ...metadataLines.map((line) => `- ${line}`),
      "",
      "If you create artifacts, write them under the output dir and use absolute paths.",
      "End your final answer with exactly one machine-readable block in this format:",
      "<<PI_TASK_RESULT_JSON",
      '{"summary":"short summary","artifacts":[{"type":"report","path":"/abs/path"}],"error":null}',
      "PI_TASK_RESULT_JSON>>",
      "Do not wrap that JSON block in markdown fences.",
    ].join("\n");
  }

  private async handleOutput(session: StoredSession, active: ActiveExecution, chunk: string, stream: string): Promise<void> {
    active.rawOutput += chunk;
    await appendFile(active.rawLogPath, chunk, "utf8");

    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const combined = active.partialLine + normalized;
    const lines = combined.split("\n");
    active.partialLine = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = stripAnsi(rawLine).trimEnd();
      if (!line) continue;
      if (!active.sawOutput) {
        active.sawOutput = true;
        await this.pushEvent(session, {
          type: "task.progress",
          session_id: session.record.session_id,
          execution_id: active.executionId,
          at: new Date().toISOString(),
          data: { status: "streaming" },
        });
      }
      await this.pushEvent(session, {
        type: "task.output",
        session_id: session.record.session_id,
        execution_id: active.executionId,
        at: new Date().toISOString(),
        data: { line, stream },
      });
    }
  }

  private async handleExit(session: StoredSession, active: ActiveExecution, exitCode: number, signal?: number | string): Promise<void> {
    if (session.active !== active) return;

    if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
    if (active.forceKillHandle) clearTimeout(active.forceKillHandle);

    if (active.partialLine.trim()) {
      await this.pushEvent(session, {
        type: "task.output",
        session_id: session.record.session_id,
        execution_id: active.executionId,
        at: new Date().toISOString(),
        data: { line: stripAnsi(active.partialLine).trimEnd(), stream: active.transport?.mode ?? "pty" },
      });
    }

    const sanitized = stripAnsi(active.rawOutput).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const hermesSessionId = parseHermesSessionId(sanitized);
    if (hermesSessionId) {
      session.record.hermes_session_id = hermesSessionId;
    }

    const responseText = removeHermesSessionFooter(sanitized).trim();
    const structured = parseStructuredWorkerResult(responseText);
    const artifacts = structured?.parsed.artifacts.length ? structured.parsed.artifacts : await detectArtifacts(active.request.output_dir);
    const cleanedResponse = structured?.remainingText.trim() ?? responseText;

    const status = active.timeoutError
      ? "failed"
      : active.intent === "cancel"
        ? "cancelled"
        : active.intent === "interrupt"
          ? "interrupted"
          : exitCode === 0
            ? "completed"
            : "failed";

    const error = active.timeoutError
      ?? structured?.parsed.error
      ?? (status === "failed" ? `Hermes exited with code ${exitCode}${signal ? ` (${String(signal)})` : ""}` : null);

    const summary = structured?.parsed.summary
      || cleanedResponse
      || (error ?? "");

    const result = HermesTaskResultSchema.parse({
      execution_id: active.executionId,
      status,
      summary,
      artifacts,
      error,
      structured_output: Boolean(structured),
    });

    await safeWriteJson(active.resultPath, result);

    const terminalEvent = {
      type: status === "completed"
        ? "task.completed"
        : status === "cancelled"
          ? "task.cancelled"
          : status === "interrupted"
            ? "task.interrupted"
            : "task.failed",
      session_id: session.record.session_id,
      execution_id: active.executionId,
      at: new Date().toISOString(),
      data: {
        exit_code: exitCode,
        signal: signal ?? null,
        summary: result.summary,
        error: result.error,
        artifact_count: result.artifacts.length,
      },
    } as const;
    await this.pushEvent(session, terminalEvent);

    session.lastResult = result;
    session.active = null;
    session.record.status = "idle";
    await safeWriteJson(join(session.record.runtime_dir, "session.json"), session.record);

    this.logger.child({ sessionId: session.record.session_id, executionId: active.executionId }).log("info", "hermes.task.exit", {
      status,
      exitCode,
      signal,
      artifactCount: result.artifacts.length,
    });

    active.resolve(result);
  }

  private terminateTransport(active: ActiveExecution | null, signal: string): void {
    if (!active?.transport) return;
    try {
      active.transport.kill(signal);
    } catch {
      // best-effort process cleanup only
    }
  }

  private async pushEvent(session: StoredSession, event: HermesTaskEvent): Promise<void> {
    const parsed = HermesTaskEventSchema.parse(event);
    session.events.push(parsed);
    const active = session.active;
    if (active) await appendFile(active.eventLogPath, JSON.stringify(parsed) + "\n", "utf8");
    const waiters = session.waiters.splice(0, session.waiters.length);
    for (const waiter of waiters) waiter();
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown Hermes session: ${sessionId}`);
    return session;
  }
}

function isTerminalEventType(type: string | undefined): boolean {
  return type === "task.completed"
    || type === "task.failed"
    || type === "task.cancelled"
    || type === "task.interrupted";
}

function stripAnsi(value: string): string {
  return stripBackspaceArtifacts(value)
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/^\^D$/, "");
}

function stripBackspaceArtifacts(value: string): string {
  let output = "";
  for (const char of value) {
    if (char === "\b" || char === "\u007f") {
      output = output.slice(0, -1);
      continue;
    }
    output += char;
  }
  return output;
}

function parseHermesSessionId(output: string): string | null {
  const match = output.match(/(?:^|\n)session_id:\s*(\S+)/);
  return match ? match[1] : null;
}

function removeHermesSessionFooter(output: string): string {
  return output.replace(/(?:^|\n)session_id:\s*\S+\s*$/gm, "");
}

function parseStructuredWorkerResult(responseText: string): { parsed: z.infer<typeof StructuredWorkerResultSchema>; remainingText: string } | null {
  const startToken = "<<PI_TASK_RESULT_JSON";
  const endToken = "PI_TASK_RESULT_JSON>>";
  const startIndex = responseText.lastIndexOf(startToken);
  if (startIndex < 0) return null;

  const endIndex = responseText.indexOf(endToken, startIndex + startToken.length);
  if (endIndex < 0) return null;

  const body = responseText.slice(startIndex + startToken.length, endIndex).trim();

  try {
    const parsedJson = JSON.parse(body);
    const parsed = StructuredWorkerResultSchema.parse(parsedJson);
    const remainingText = (responseText.slice(0, startIndex) + responseText.slice(endIndex + endToken.length)).trim();
    return { parsed, remainingText };
  } catch {
    return null;
  }
}

async function detectArtifacts(outputDir: string): Promise<z.infer<typeof HermesArtifactSchema>[]> {
  const artifacts: z.infer<typeof HermesArtifactSchema>[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".pi-hermes") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        artifacts.push(HermesArtifactSchema.parse({
          type: inferArtifactType(entry.name),
          path: resolve(fullPath),
        }));
      }
    }
  }

  try {
    await walk(outputDir);
  } catch {
    return [];
  }

  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

function inferArtifactType(fileName: string): string {
  if (fileName.endsWith(".patch") || fileName.endsWith(".diff")) return "patch";
  if (fileName.endsWith(".md") || fileName.endsWith(".txt")) return "report";
  if (fileName.endsWith(".json")) return "json";
  return "file";
}
