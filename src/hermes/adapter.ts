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
  /**
   * Cap on the raw worker output retained in memory for end-of-run parsing
   * (structured result block + session footer, both emitted last). The full
   * stream is always appended to hermes.raw.log on disk regardless.
   */
  maxRetainedOutputChars?: number;
  /**
   * Cap on the task events retained in memory per session. A long-lived
   * session accumulates every task.output line of every execution it ever
   * ran; the oldest events are trimmed past this cap. Each execution's full
   * event history is always appended to its events.jsonl on disk regardless.
   */
  maxRetainedSessionEvents?: number;
}

const DEFAULT_MAX_RETAINED_OUTPUT_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_SESSION_EVENTS = 10_000;

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
  outputChain: Promise<void>;
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
  /** Count of events trimmed from the front of `events` by the retention cap. */
  eventsTrimmed: number;
  /** Executions that already emitted a terminal event (survives trimming). */
  terminalExecutionIds: Set<string>;
  waiters: Array<() => void>;
  active: ActiveExecution | null;
  lastResult: HermesTaskResult | null;
  closed: boolean;
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
  private readonly maxRetainedOutputChars: number;
  private readonly maxRetainedSessionEvents: number;

  constructor(options: HermesAdapterOptions = {}) {
    this.command = options.command ?? detectHermesBinaryPath(process.env) ?? process.env.HERMES_COMMAND ?? "hermes";
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
    this.stateRoot = resolve(options.stateRoot ?? join(tmpdir(), "pi-hermes-adapter"));
    this.preferTransport = options.preferTransport ?? "pty";
    this.source = options.source ?? "tool";
    this.logger = options.logger ?? new NoopLogger();
    this.ptyCols = options.ptyCols ?? 120;
    this.ptyRows = options.ptyRows ?? 30;
    this.maxRetainedOutputChars = options.maxRetainedOutputChars ?? DEFAULT_MAX_RETAINED_OUTPUT_CHARS;
    this.maxRetainedSessionEvents = options.maxRetainedSessionEvents ?? DEFAULT_MAX_RETAINED_SESSION_EVENTS;
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
      eventsTrimmed: 0,
      terminalExecutionIds: new Set(),
      waiters: [],
      active: null,
      lastResult: null,
      closed: false,
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
      outputChain: Promise.resolve(),
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
        // Serialize chunk handling: partialLine reconstruction and log
        // appends happen across awaits, so concurrent handlers would
        // interleave lines out of order.
        active.outputChain = active.outputChain
          .then(() => this.handleOutput(session, active, chunk, stream))
          .catch(() => { /* per-chunk append failure; keep draining */ });
      });
      transport.onExit((event) => {
        void this.handleExit(session, active, event.exitCode, event.signal).catch(async (error) => {
          // A failure while finalizing the exited run (result write, event
          // append) must not surface as an unhandledRejection that kills the
          // harness, and the completion promise must still settle so
          // collect_result callers see the failure instead of parking.
          this.logger.child({ sessionId, executionId }).log("error", "hermes.task.exit_finalize_failed", {
            error: String(error),
          });
          if (session.active === active) {
            session.active = null;
            session.record.status = "idle";
          }
          try {
            await this.pushEvent(session, {
              type: "task.failed",
              session_id: sessionId,
              execution_id: executionId,
              at: new Date().toISOString(),
              data: { error: String(error), finalize_failed: true },
            });
          } catch {
            // best-effort terminal event; the rejection below is authoritative
          }
          active.completion.catch(() => { /* settled via rejection below */ });
          active.reject(error);
        });
      });

      active.timeoutHandle = setTimeout(() => {
        active.timeoutError = `Timed out after ${request.timeout_seconds} seconds`;
        this.logger.child({ sessionId, executionId }).log("warn", "hermes.task.timeout", {
          timeoutSeconds: request.timeout_seconds,
        });
        this.terminateTransport(active, "SIGTERM");
        if (active.forceKillHandle) clearTimeout(active.forceKillHandle);
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
      // The failure may have happened *after* spawnHermesTransport returned
      // (the post-spawn progress event append, the timeout arm). The run is
      // abandoned below, so nothing will ever supervise or reap that worker:
      // handleExit bails on `session.active !== active`, and the transport
      // keeps running until it finishes on its own. Kill it before the
      // session is released so a failed accept cannot orphan a process tree.
      if (active.transport) {
        this.terminateTransport(active, "SIGKILL");
        active.transport = null;
      }
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
      if (active.forceKillHandle) clearTimeout(active.forceKillHandle);
      const result = HermesTaskResultSchema.parse({
        execution_id: executionId,
        status: "failed",
        summary: "",
        artifacts: [],
        error: error instanceof Error ? error.message : String(error),
        structured_output: false,
      });
      await safeWriteJson(resultPath, result);
      // Emit a terminal event so read_events watchers keyed to this
      // execution terminate instead of parking forever on a run whose
      // worker never spawned. This must happen while session.active is
      // still set: pushEvent only appends to the execution's on-disk
      // events.jsonl for the active execution, and the persisted log
      // otherwise records task.started with no terminal event.
      await this.pushEvent(session, {
        type: "task.failed",
        session_id: sessionId,
        execution_id: executionId,
        at: new Date().toISOString(),
        data: {
          error: result.error,
          spawn_failed: true,
        },
      });
      session.active = null;
      session.lastResult = result;
      session.record.status = "idle";
      await safeWriteJson(join(session.record.runtime_dir, "session.json"), session.record);
      // Nothing awaits the completion promise on this path (collect_result
      // was never reachable), so mark the rejection handled before
      // rejecting or Node terminates the harness with an unhandledRejection.
      active.completion.catch(() => { /* settled via the thrown error below */ });
      active.reject(error);
      throw error;
    }
  }

  async *read_events(sessionId: string, executionId?: string): AsyncGenerator<HermesTaskEvent> {
    const session = this.requireSession(sessionId);
    // Absolute event index: the retention cap trims the oldest entries out
    // of session.events, so buffer positions shift under a paused reader.
    let cursor = session.eventsTrimmed;
    let sawExecution = false;
    while (true) {
      while (true) {
        // Retention overtook this reader (it parked across more than a
        // cap's worth of pushes); the trimmed events are gone, so resume
        // at the oldest retained one.
        if (cursor < session.eventsTrimmed) cursor = session.eventsTrimmed;
        const index = cursor - session.eventsTrimmed;
        if (index >= session.events.length) break;
        const event = session.events[index];
        cursor += 1;
        if (executionId && event.execution_id !== executionId) continue;
        sawExecution = true;
        yield event;
        if (executionId && isTerminalEventType(event.type)) return;
      }
      const lastEvent = executionId
        ? findLastEventForExecution(session.events, executionId)
        : session.events[session.events.length - 1];
      if (sawExecution && !session.active && isTerminalEventType(lastEvent?.type)) return;
      // The retention cap can trim a finished execution's events out of the
      // retained window entirely; terminalExecutionIds remembers executions
      // whose terminal event was already pushed so a late reader returns
      // instead of parking on a waiter that never fires for it again.
      if (executionId && session.terminalExecutionIds.has(executionId)) return;
      // A closed session will never emit again; without this check a pending
      // iterator would park on a waiter that nothing ever wakes.
      if (session.closed) return;
      await new Promise<void>((resolvePromise) => {
        session.waiters.push(resolvePromise);
      });
    }
  }

  async interrupt(sessionId: string, executionId?: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const active = session.active;
    if (!active) return;
    // When the caller names an execution, only signal that execution: an
    // interrupt aimed at a finished run must not hit whatever execution
    // happens to be active on the session now.
    if (executionId && active.executionId !== executionId) return;
    active.intent = "interrupt";
    this.terminateTransport(active, "SIGINT");
  }

  async cancel(sessionId: string, executionId?: string): Promise<void> {
    const session = this.requireSession(sessionId);
    // Capture the execution being cancelled: the force-kill timer must not
    // re-read session.active when it fires, or it could SIGKILL a subsequent
    // execution that started after this one exited.
    const active = session.active;
    if (!active) return;
    if (executionId && active.executionId !== executionId) return;
    active.intent = "cancel";
    this.terminateTransport(active, "SIGTERM");
    if (active.forceKillHandle) clearTimeout(active.forceKillHandle);
    active.forceKillHandle = setTimeout(() => {
      this.terminateTransport(active, "SIGKILL");
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
    session.closed = true;
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
    if (active.rawOutput.length > this.maxRetainedOutputChars) {
      // Keep only the tail in memory: a chatty long-running worker must not
      // grow the harness heap without bound, and everything parsed at exit
      // (structured result block, session footer) arrives at the end.
      active.rawOutput = active.rawOutput.slice(-this.maxRetainedOutputChars);
    }
    await appendFile(active.rawLogPath, chunk, "utf8");

    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const combined = active.partialLine + normalized;
    const lines = combined.split("\n");
    active.partialLine = lines.pop() ?? "";
    if (active.partialLine.length > this.maxRetainedOutputChars) {
      // A worker that streams one enormous line with no newline would grow
      // partialLine without bound, defeating the rawOutput retention cap
      // above. Keep the tail: the line is only ever consumed from its end
      // (flushed as a task.output event when the newline or exit arrives).
      active.partialLine = active.partialLine.slice(-this.maxRetainedOutputChars);
    }

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

    await active.outputChain.catch(() => { /* chunk failures already swallowed per-chunk */ });

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
      timed_out: Boolean(active.timeoutError),
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
        timed_out: result.timed_out,
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
    if (isTerminalEventType(parsed.type)) session.terminalExecutionIds.add(parsed.execution_id);
    const excess = session.events.length - this.maxRetainedSessionEvents;
    if (excess > 0) {
      // A long-lived session retains every task.output line of every
      // execution it ever ran; without this cap the array grows without
      // bound, the same way rawOutput and partialLine did before their
      // caps. Trim the oldest events; each execution's full history is
      // still on disk in its events.jsonl.
      session.events.splice(0, excess);
      session.eventsTrimmed += excess;
    }
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

function findLastEventForExecution(events: HermesTaskEvent[], executionId: string): HermesTaskEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].execution_id === executionId) return events[index];
  }
  return undefined;
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
  // stripAnsi runs on every worker output line and again over the whole
  // retained transcript at exit, and the loop below allocates a fresh string
  // per character. The overwhelming majority of lines carry no erase
  // character at all, so scanning for one first and returning the input
  // untouched is ~30x cheaper on that path (measured on typical log lines).
  if (!value.includes("\b") && !value.includes("\u007f")) return value;
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
  // Only a full `session_id: <id>` line counts, and the *last* one wins: the
  // genuine footer is emitted at the very end of the stream. Worker output
  // that merely mentions "session_id: x" mid-run (echoed env, logs, or
  // hostile text) must not be captured and resumed on the next task.
  let last: string | null = null;
  for (const match of output.matchAll(/(?:^|\n)session_id:[ \t]*(\S+)[ \t]*(?=\n|$)/g)) {
    last = match[1];
  }
  return last;
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

export interface ArtifactScanLimits {
  maxDepth: number;
  maxArtifacts: number;
}

/**
 * The output dir is written by the worker, which docs/THREAT-MODEL.md treats
 * as untrusted. Every file found here becomes an artifact record that is
 * hashed, persisted into the result envelope, and shipped over HTTP, so an
 * unbounded scan turns a worker that dumps a node_modules tree (or nests
 * directories in a loop) into an unbounded finalization cost on a Pi. Bound
 * both dimensions; the raw files stay on disk either way.
 */
const DEFAULT_ARTIFACT_SCAN_LIMITS: ArtifactScanLimits = {
  maxDepth: 24,
  maxArtifacts: 5000,
};

async function detectArtifacts(
  outputDir: string,
  limits: ArtifactScanLimits = DEFAULT_ARTIFACT_SCAN_LIMITS,
): Promise<z.infer<typeof HermesArtifactSchema>[]> {
  const artifacts: z.infer<typeof HermesArtifactSchema>[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // One unreadable subdirectory (permissions, races with cleanup) must
      // not discard the artifacts already collected from readable ones.
      return;
    }
    // Deterministic traversal so the truncated set is stable across runs
    // rather than whatever order the filesystem happened to return.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (artifacts.length >= limits.maxArtifacts) return;
      if (entry.name === ".pi-hermes") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        artifacts.push(HermesArtifactSchema.parse({
          type: inferArtifactType(entry.name),
          path: resolve(fullPath),
        }));
      }
    }
  }

  await walk(outputDir, 0);

  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

export const __adapterTestables = { detectArtifacts, stripAnsi, DEFAULT_ARTIFACT_SCAN_LIMITS };

function inferArtifactType(fileName: string): string {
  if (fileName.endsWith(".patch") || fileName.endsWith(".diff")) return "patch";
  if (fileName.endsWith(".md") || fileName.endsWith(".txt")) return "report";
  if (fileName.endsWith(".json")) return "json";
  return "file";
}
