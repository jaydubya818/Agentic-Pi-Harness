import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { URL } from "node:url";
import { NoopLogger, type Logger } from "../obs/logger.js";
import {
  detectHermes,
  HermesAdapter,
  type HermesAdapterOptions,
  type HermesAdapterSession,
  HermesTaskRequestSchema,
  type HermesTaskRequest,
  type HermesTaskResult,
  PiHermesResultEnvelopeV2Schema,
  PiHermesStructuredEventV2Schema,
  PiHermesTaskEnvelopeV2Schema,
  assertRequiredFrontmatter,
  assertValidStateTransition,
  buildLegacyObjectiveFromV2,
  classifyKnowledgePath,
  computeArtifactManifestItem,
  deriveArtifactRoot,
  deriveHermesOutputDirFromV2Artifacts,
  ensureKnowledgeDirectorySkeleton,
  ensureMissionRunSkeleton,
  inferMissionRunRootFromPath,
  isTerminalV2State,
  resolveKnowledgeRoots,
  writeJsonArtifact,
  writeKnowledgeJson,
  type KnowledgeRoots,
  type PiHermesFailureClass,
  type PiHermesResultEnvelopeV2,
  type PiHermesRunState,
  type PiHermesStructuredEventV2,
  type PiHermesTaskEnvelopeV2,
} from "./index.js";
import { HermesBridgeStateStore, type BridgeEventRecord, type BridgeStateRunRecord } from "./bridgeState.js";

interface StartSessionBody {
  workdir: string;
  env?: NodeJS.ProcessEnv;
  profile?: string;
}

export interface HermesBridgeServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  stateRoot?: string;
  heartbeatIntervalMs?: number;
  stuckTimeoutMs?: number;
  emitSemanticHeartbeats?: boolean;
  knowledgeRoots?: Partial<KnowledgeRoots>;
  enforceKnowledgePolicy?: boolean;
  adapter?: HermesAdapter;
  adapterOptions?: HermesAdapterOptions;
  logger?: Logger;
}

export interface HermesBridgeRunRecord extends BridgeStateRunRecord {}

interface SseSubscriber {
  res: ServerResponse;
  send(eventId: number, event: BridgeEventRecord): void;
  close(): void;
}

interface ActiveHeartbeatController {
  stop(): void;
}

export class HermesBridgeServer {
  private readonly host: string;
  private readonly port: number;
  private readonly authToken: string | null;
  readonly stateRoot: string;
  private readonly logger: Logger;
  private readonly adapter: HermesAdapter;
  private readonly stateStore: HermesBridgeStateStore;
  private readonly knowledgeRoots: KnowledgeRoots;
  private readonly enforceKnowledgePolicy: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly stuckTimeoutMs: number;
  private readonly emitSemanticHeartbeats: boolean;
  private server: Server | null = null;
  private readonly sessions = new Map<string, HermesAdapterSession>();
  private readonly runs = new Map<string, HermesBridgeRunRecord>();
  private readonly activeWatchers = new Set<Promise<void>>();
  private readonly subscribers = new Map<string, Set<SseSubscriber>>();
  private readonly heartbeatControllers = new Map<string, ActiveHeartbeatController>();

  constructor(options: HermesBridgeServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8787;
    this.authToken = options.authToken ?? null;
    this.stateRoot = resolve(options.stateRoot ?? join(homedir(), ".pi", "hermes-bridge-state"));
    this.logger = options.logger ?? new NoopLogger();
    this.adapter = options.adapter ?? new HermesAdapter(options.adapterOptions);
    this.stateStore = new HermesBridgeStateStore(this.stateRoot);
    this.knowledgeRoots = resolveKnowledgeRoots(options.knowledgeRoots);
    this.enforceKnowledgePolicy = options.enforceKnowledgePolicy ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.stuckTimeoutMs = options.stuckTimeoutMs ?? 30000;
    this.emitSemanticHeartbeats = options.emitSemanticHeartbeats ?? true;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("HermesBridgeServer already started");

    await mkdir(this.stateRoot, { recursive: true });
    if (this.enforceKnowledgePolicy) await ensureKnowledgeDirectorySkeleton(this.knowledgeRoots);
    await this.stateStore.init();
    const snapshot = await this.stateStore.load();
    for (const session of snapshot.sessions) this.sessions.set(session.session_id, session);
    for (const run of snapshot.runs) this.runs.set(run.accepted.execution_id, run);

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.logger.log("error", "hermes.bridge.unhandled", { error: String(error) });
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    await new Promise<void>((resolvePromise) => {
      this.server!.listen(this.port, this.host, () => resolvePromise());
    });

    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.port;
    this.logger.log("info", "hermes.bridge.started", { host: this.host, port });
    return { host: this.host, port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const controller of this.heartbeatControllers.values()) controller.stop();
    this.heartbeatControllers.clear();
    for (const subscriberSet of this.subscribers.values()) {
      for (const subscriber of subscriberSet) subscriber.close();
    }
    this.subscribers.clear();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server!.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
    await Promise.allSettled(Array.from(this.activeWatchers));
    this.server = null;
  }

  getRun(executionId: string): HermesBridgeRunRecord | null {
    return this.runs.get(executionId) ?? null;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.authToken) return true;
    const header = req.headers.authorization;
    return header === `Bearer ${this.authToken}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }

    if (!this.isAuthorized(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (method === "GET" && path === "/meta") {
      json(res, 200, { ...detectHermes(), authRequired: Boolean(this.authToken), stateRoot: this.stateRoot });
      return;
    }

    if (method === "GET" && path === "/preflight-denials") {
      json(res, 200, await this.stateStore.loadPreflightDenials());
      return;
    }

    if (method === "POST" && path === "/sessions") {
      const body = await readJson<StartSessionBody>(req);
      const session = await this.adapter.start_session(body.workdir, {
        env: body.env,
        profile: body.profile,
      });
      this.sessions.set(session.session_id, session);
      await this.stateStore.persistSession(session);
      json(res, 200, session);
      return;
    }

    if (method === "POST" && path === "/execute") {
      const body = await readJson(req);
      const parsedV2 = PiHermesTaskEnvelopeV2Schema.safeParse(body);
      if (parsedV2.success) {
        try {
          const accepted = await this.executeV2(parsedV2.data);
          json(res, 202, accepted);
        } catch (error) {
          await this.persistPreflightDenial({
            code: "v2_preflight_denied",
            message: error instanceof Error ? error.message : String(error),
            request_id: parsedV2.data.request_id,
            run_id: parsedV2.data.run_id,
            mission_id: parsedV2.data.mission_id,
            session_id: parsedV2.data.session_id,
            execution_id: parsedV2.data.execution_id,
            detail: { body },
          });
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const parsedLegacy = HermesTaskRequestSchema.safeParse(body);
      if (!parsedLegacy.success) {
        await this.persistPreflightDenial({
          code: "invalid_request_envelope",
          message: "invalid request envelope",
          detail: parsedLegacy.error.issues,
        });
        json(res, 400, { error: "invalid request envelope", issues: parsedLegacy.error.issues });
        return;
      }

      try {
        const accepted = await this.executeLegacy(parsedLegacy.data);
        json(res, 202, accepted);
      } catch (error) {
        await this.persistPreflightDenial({
          code: "legacy_preflight_denied",
          message: error instanceof Error ? error.message : String(error),
          request_id: parsedLegacy.data.request_id,
          run_id: parsedLegacy.data.metadata.run_id ?? null,
          mission_id: parsedLegacy.data.metadata.mission_id ?? null,
          session_id: parsedLegacy.data.session_id,
          execution_id: parsedLegacy.data.execution_id ?? null,
          detail: { body },
        });
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && path === "/interrupt") {
      const body = await readJson<{ execution_id: string }>(req);
      const run = this.runs.get(body.execution_id);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${body.execution_id}` });
        return;
      }
      await this.adapter.interrupt(run.session.session_id);
      json(res, 202, { execution_id: body.execution_id, status: "interrupted" });
      return;
    }

    if (method === "POST" && path === "/cancel") {
      const body = await readJson<{ execution_id: string }>(req);
      const run = this.runs.get(body.execution_id);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${body.execution_id}` });
        return;
      }
      await this.adapter.cancel(run.session.session_id);
      json(res, 202, { execution_id: body.execution_id, status: "cancelled" });
      return;
    }

    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const run = this.runs.get(runMatch[1]);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${runMatch[1]}` });
        return;
      }
      if (url.searchParams.get("view") === "raw") {
        json(res, 200, serializeLegacyRunShape(run));
        return;
      }
      json(res, 200, serializeRun(run));
      return;
    }

    const eventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      const run = this.runs.get(eventsMatch[1]);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${eventsMatch[1]}` });
        return;
      }
      if (url.searchParams.get("stream") === "1") {
        this.streamRunEvents(req, res, run);
        return;
      }
      if (url.searchParams.get("view") === "raw") {
        json(res, 200, run.events);
        return;
      }
      json(res, 200, serializeRunEvents(run));
      return;
    }

    const eventsStreamMatch = path.match(/^\/runs\/([^/]+)\/events\/stream$/);
    if (method === "GET" && eventsStreamMatch) {
      const run = this.runs.get(eventsStreamMatch[1]);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${eventsStreamMatch[1]}` });
        return;
      }
      this.streamRunEvents(req, res, run);
      return;
    }

    json(res, 404, { error: "not found" });
  }

  private async persistPreflightDenial(record: {
    code: string;
    message: string;
    request_id?: string | null;
    run_id?: string | null;
    mission_id?: string | null;
    session_id?: string | null;
    execution_id?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.stateStore.appendPreflightDenial({
      at: new Date().toISOString(),
      ...record,
    });
  }

  private async executeLegacy(request: HermesTaskRequest) {
    const session = this.sessions.get(request.session_id);
    if (!session) throw new Error(`unknown session_id: ${request.session_id}`);
    if (this.enforceKnowledgePolicy) {
      const info = classifyKnowledgePath(request.output_dir, this.knowledgeRoots);
      if (!["wiki", "kb_discovery", "kb_handoff_inbound", "kb_mission_outputs"].includes(info.pathClass)) {
        throw new Error(`legacy Hermes output_dir is not in an approved Hermes write zone: ${request.output_dir}`);
      }
    }
    const accepted = await this.adapter.send_task(request.session_id, request);
    const record: HermesBridgeRunRecord = {
      accepted,
      request: parsedLegacyRequest(request),
      status: "accepted",
      session,
      events: [],
      result: null,
      error: null,
    };
    this.runs.set(accepted.execution_id, record);
    await this.stateStore.persistRun(record);
    const watcher = this.watchRun(record).finally(() => this.activeWatchers.delete(watcher));
    this.activeWatchers.add(watcher);
    return accepted;
  }

  private async executeV2(task: PiHermesTaskEnvelopeV2) {
    const session = this.sessions.get(task.session_id);
    if (!session) throw new Error(`unknown session_id: ${task.session_id}`);

    if (this.enforceKnowledgePolicy) {
      await this.preflightV2KnowledgePolicy(task);
    }

    const outputDir = this.enforceKnowledgePolicy
      ? deriveHermesOutputDirFromV2Artifacts(task.artifacts_expected.map((artifact) => artifact.path), this.knowledgeRoots)
      : deriveArtifactRoot(task);
    const legacyRequest = HermesTaskRequestSchema.parse({
      request_id: task.request_id,
      session_id: task.session_id,
      execution_id: task.execution_id,
      objective: buildLegacyObjectiveFromV2(task),
      workdir: task.workdir,
      allowed_tools: task.allowed_tools,
      allowed_actions: task.constraints.write_access ? ["read", "write"] : ["read"],
      timeout_seconds: task.timeout_seconds,
      output_dir: outputDir,
      metadata: {
        mission_id: task.mission_id,
        run_id: task.run_id,
        step_id: String(task.metadata.step_id ?? "step-1"),
      },
    });

    const accepted = await this.adapter.send_task(task.session_id, legacyRequest);
    const record: HermesBridgeRunRecord = {
      accepted,
      request: legacyRequest,
      status: "accepted",
      state: "accepted",
      session,
      events: [],
      result: null,
      error: null,
      v2Task: task,
      v2Result: null,
      failureClass: null,
    };
    this.runs.set(accepted.execution_id, record);
    await this.stateStore.persistRun(record);
    await this.emitV2Event(record, {
      event_type: "run.accepted",
      state: "accepted",
      agent: "pi",
      message: "Run accepted by bridge",
      payload: {},
    });
    await this.emitKbPreflightAllowedEvents(record);
    const watcher = this.watchRun(record).finally(() => this.activeWatchers.delete(watcher));
    this.activeWatchers.add(watcher);
    return accepted;
  }

  private async watchRun(run: HermesBridgeRunRecord): Promise<void> {
    const heartbeatController = run.v2Task ? this.startHeartbeat(run) : null;
    if (heartbeatController) this.heartbeatControllers.set(run.accepted.execution_id, heartbeatController);

    try {
      for await (const event of this.adapter.read_events(run.session.session_id, run.accepted.execution_id)) {
        run.events.push(event);
        const status = statusFromLegacyEvent(event.type);
        if (status) run.status = status;
        await this.stateStore.appendRunEvent(run.accepted.execution_id, event);
        if (run.v2Task) {
          await this.handleV2AdapterEvent(run, event);
        } else {
          await this.stateStore.persistRun(run);
          this.broadcastEvent(run, event);
        }
      }

      const result = await this.adapter.collect_result(run.session.session_id);
      run.result = result;
      run.status = result.status;

      if (run.v2Task) {
        if (run.state && isTerminalV2State(run.state as PiHermesRunState)) {
          await this.stateStore.persistRun(run);
        } else {
          await this.finalizeV2Run(run, result);
        }
      } else {
        run.error = result.error;
        await this.stateStore.persistRun(run);
      }
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      if (run.v2Task) {
        if (!run.failureClass) {
          await this.failV2Run(run, "failed", "execution_error", run.error);
        }
      }
      await this.stateStore.persistRun(run);
    } finally {
      heartbeatController?.stop();
      this.heartbeatControllers.delete(run.accepted.execution_id);
      this.closeSubscribers(run.accepted.execution_id);
    }
  }

  private startHeartbeat(run: HermesBridgeRunRecord): ActiveHeartbeatController {
    let stopped = false;
    let lastSemanticHeartbeatAt = Date.now();
    (run as HermesBridgeRunRecord & { __lastProgressAt?: number }).__lastProgressAt = Date.now();

    const heartbeatTick = setInterval(() => {
      void (async () => {
        if (stopped || !run.v2Task) return;
        if (run.state !== "running" && run.state !== "starting") return;
        if (this.emitSemanticHeartbeats) {
          lastSemanticHeartbeatAt = Date.now();
          await this.emitV2Event(run, {
            event_type: "task.heartbeat",
            state: run.state as PiHermesRunState,
            agent: "pi",
            message: "Supervisor heartbeat",
            payload: {
              elapsed_ms: Date.now() - Date.parse((run.v2Task.metadata.started_at as string | undefined) ?? new Date().toISOString()),
              recent_activity_ms: Date.now() - ((run as HermesBridgeRunRecord & { __lastProgressAt?: number }).__lastProgressAt ?? Date.now()),
            },
          });
        }
      })().catch(() => {
        stopped = true;
      });
    }, this.heartbeatIntervalMs);

    const stuckTick = setInterval(() => {
      void (async () => {
        if (stopped || !run.v2Task) return;
        if (run.state !== "running" && run.state !== "starting") return;
        if (Date.now() - lastSemanticHeartbeatAt < this.stuckTimeoutMs) return;
        stopped = true;
        await this.adapter.cancel(run.session.session_id);
        await this.failV2Run(run, "failed", "stuck_run", "semantic heartbeat missing beyond supervisor threshold");
      })().catch(() => {
        stopped = true;
      });
    }, Math.max(250, Math.floor(this.stuckTimeoutMs / 4)));

    return {
      stop: () => {
        stopped = true;
        clearInterval(heartbeatTick);
        clearInterval(stuckTick);
      },
    };
  }

  private async handleV2AdapterEvent(run: HermesBridgeRunRecord, event: BridgeEventRecord): Promise<void> {
    if (run.state && isTerminalV2State(run.state as PiHermesRunState)) return;
    const kind = getEventKind(event);
    switch (kind) {
      case "task.started":
        await this.transitionV2State(run, "starting", {
          event_type: "run.started",
          agent: "hermes",
          message: "Worker execution started",
          payload: getEventPayload(event),
        });
        break;
      case "task.progress":
      case "task.output":
        (run as HermesBridgeRunRecord & { __lastProgressAt?: number }).__lastProgressAt = Date.now();
        if (run.state === "starting" || run.state === "accepted") {
          await this.transitionV2State(run, "running", {
            event_type: "run.progress",
            agent: "hermes",
            message: kind === "task.output" ? String(getEventPayload(event).line ?? "worker output") : "Worker progress event",
            payload: getEventPayload(event),
          });
        } else if (run.state === "running") {
          await this.emitV2Event(run, {
            event_type: "run.progress",
            state: "running",
            agent: "hermes",
            message: kind === "task.output" ? String(getEventPayload(event).line ?? "worker output") : "Worker progress event",
            payload: getEventPayload(event),
          });
        }
        break;
      case "task.failed":
        await this.failV2Run(run, "failed", "execution_error", "worker reported task failure");
        break;
      case "task.cancelled":
        await this.failV2Run(run, "cancelled", "execution_error", "worker reported cancellation");
        break;
      case "task.interrupted":
        await this.failV2Run(run, "interrupted", "execution_error", "worker reported interruption");
        break;
      default:
        break;
    }

    await this.stateStore.persistRun(run);
  }

  private async finalizeV2Run(run: HermesBridgeRunRecord, adapterResult: HermesTaskResult): Promise<void> {
    const task = run.v2Task;
    if (!task) return;

    if (!adapterResult.structured_output) {
      await this.failV2Run(run, "failed", "contract_error", "worker result payload was not structured");
      return;
    }

    if (!run.state) run.state = "running";
    if (run.state === "running") {
      await this.transitionV2State(run, "producing_artifacts", {
        event_type: "run.progress",
        agent: "pi",
        message: "Producing and validating contract artifacts",
        payload: {},
      });
    }

    const now = new Date();
    const startedAt = extractStartedAt(run) ?? now.toISOString();

    const tracePath = requiredArtifactPath(task, "trace");
    await writeJsonArtifact(tracePath, {
      schema_version: "2.0",
      execution_id: run.accepted.execution_id,
      events: run.events,
    });

    let failureClass: PiHermesFailureClass | null = null;
    let errorMessage: string | null = null;
    const manifestItems = [];

    for (const expected of task.artifacts_expected) {
      const exists = await fileExists(expected.path);
      if (!exists && expected.required && expected.type !== "result" && expected.type !== "manifest") {
        failureClass = "artifact_error";
        errorMessage = `required artifact missing: ${expected.path}`;
      }
    }

    for (const expected of task.artifacts_expected.filter((item) => item.type !== "result" && item.type !== "manifest")) {
      if (await fileExists(expected.path)) {
        const info = classifyKnowledgePath(expected.path, this.knowledgeRoots);
        if (info.requiresFrontmatter) {
          const content = await readFile(expected.path, "utf8");
          try {
            assertRequiredFrontmatter(content, expected.path);
          } catch (error) {
            failureClass = "validation_error";
            errorMessage = error instanceof Error ? error.message : String(error);
            await this.emitV2Event(run, {
              event_type: "kb.frontmatter_validation_failed",
              state: "producing_artifacts",
              agent: "pi",
              message: errorMessage,
              payload: { path: expected.path, path_class: info.pathClass },
            });
          }
        }
        const item = await computeArtifactManifestItem({
          artifactId: `art_${expected.type}_${manifestItems.length + 1}`,
          type: expected.type,
          role: expected.role,
          path: expected.path,
          producedBy: expected.type === "trace" ? "pi" : "hermes",
          description: expected.description,
        });
        manifestItems.push(item);
        await this.emitV2Event(run, {
          event_type: "artifact.produced",
          state: "producing_artifacts",
          agent: item.produced_by,
          message: `Artifact produced: ${item.path}`,
          artifact_refs: [item.artifact_id],
          payload: { path: item.path, type: item.type, role: item.role },
        });
      }
    }

    const resultPath = requiredArtifactPath(task, "result");
    const manifestPath = requiredArtifactPath(task, "manifest");
    const placeholderResultItem = await buildPlaceholderArtifact("art_result_1", "result", "primary_result", resultPath, "pi", "Structured result envelope");
    const placeholderManifestItem = await buildPlaceholderArtifact("art_manifest_1", "manifest", "primary_result", manifestPath, "pi", "Artifact manifest");
    let artifactManifest = [...manifestItems, placeholderResultItem, placeholderManifestItem];

    let resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, now.toISOString(), failureClass, errorMessage);
    await writeJsonArtifact(resultPath, resultEnvelope);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    await writeJsonArtifact(manifestPath, artifactManifest);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, new Date().toISOString(), failureClass, errorMessage);
    await writeJsonArtifact(resultPath, resultEnvelope);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    await writeJsonArtifact(manifestPath, artifactManifest);
    resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, new Date().toISOString(), failureClass, errorMessage);
    await writeJsonArtifact(resultPath, resultEnvelope);

    for (const item of artifactManifest) {
      await this.emitV2Event(run, {
        event_type: "artifact.validated",
        state: "producing_artifacts",
        agent: "pi",
        message: `Artifact validated: ${item.path}`,
        artifact_refs: [item.artifact_id],
        payload: { path: item.path, sha256: item.sha256, size_bytes: item.size_bytes },
      });
    }

    run.v2Result = PiHermesResultEnvelopeV2Schema.parse(resultEnvelope);
    run.failureClass = failureClass;

    if (failureClass) {
      await this.failV2Run(run, "failed", failureClass, errorMessage ?? "artifact validation failed");
      return;
    }

    await this.transitionV2State(run, "succeeded", {
      event_type: "run.completed",
      agent: "pi",
      message: adapterResult.summary,
      payload: { artifact_count: artifactManifest.length },
    });
    run.status = "completed";
    run.result = adapterResult;
    run.error = null;
    await this.stateStore.persistRun(run);
  }

  private async failV2Run(
    run: HermesBridgeRunRecord,
    terminalState: Extract<PiHermesRunState, "failed" | "cancelled" | "interrupted" | "timed_out">,
    failureClass: PiHermesFailureClass,
    message: string | null,
  ): Promise<void> {
    run.failureClass = failureClass;
    if (run.state && !isTerminalV2State(run.state as PiHermesRunState)) {
      try {
        assertValidStateTransition(run.state as PiHermesRunState, terminalState);
        run.state = terminalState;
      } catch {
        run.state = terminalState;
      }
    } else {
      run.state = terminalState;
    }

    const eventType = terminalState === "cancelled"
      ? "run.cancelled"
      : terminalState === "interrupted"
        ? "run.interrupted"
        : terminalState === "timed_out"
          ? "run.timed_out"
          : "run.failed";

    await this.emitV2Event(run, {
      event_type: eventType,
      state: terminalState,
      agent: "pi",
      message,
      payload: {},
      error_code: failureClass,
    });
    run.status = terminalState === "timed_out" ? "failed" : terminalStateToLegacyStatus(terminalState);
    run.error = message;
    await this.stateStore.persistRun(run);
  }

  private async transitionV2State(
    run: HermesBridgeRunRecord,
    next: PiHermesRunState,
    event: {
      event_type: PiHermesStructuredEventV2["event_type"];
      agent: string;
      message: string | null;
      payload: Record<string, unknown>;
      artifact_refs?: string[];
      error_code?: string | null;
    },
  ): Promise<void> {
    const current = (run.state ?? "accepted") as PiHermesRunState;
    if (current !== next) assertValidStateTransition(current, next);
    run.state = next;
    await this.emitV2Event(run, {
      ...event,
      state: next,
    });
    await this.stateStore.persistRun(run);
  }

  private async emitV2Event(
    run: HermesBridgeRunRecord,
    input: {
      event_type: PiHermesStructuredEventV2["event_type"];
      state: PiHermesRunState;
      agent: string;
      message: string | null;
      payload: Record<string, unknown>;
      artifact_refs?: string[];
      error_code?: string | null;
    },
  ): Promise<void> {
    const task = run.v2Task;
    if (!task) return;
    const event = PiHermesStructuredEventV2Schema.parse({
      event_id: getPublicEvents(run).length + 1,
      timestamp: new Date().toISOString(),
      schema_version: "2.0",
      event_type: input.event_type,
      state: input.state,
      request_id: task.request_id,
      run_id: task.run_id,
      mission_id: task.mission_id,
      session_id: task.session_id,
      execution_id: task.execution_id,
      agent: input.agent,
      message: input.message,
      artifact_refs: input.artifact_refs ?? [],
      payload: input.payload,
      error_code: input.error_code ?? null,
    });
    run.events.push(event);
    await this.stateStore.appendRunEvent(run.accepted.execution_id, event);
    await this.stateStore.persistRun(run);
    this.broadcastEvent(run, event);
  }

  private async preflightV2KnowledgePolicy(task: PiHermesTaskEnvelopeV2): Promise<void> {
    for (const artifact of task.artifacts_expected) {
      const info = classifyKnowledgePath(artifact.path, this.knowledgeRoots);
      if (artifact.type === "result" || artifact.type === "manifest") {
        if (!["wiki", "kb_mission_outputs"].includes(info.pathClass)) {
          throw new Error(`${artifact.type} artifact must be written to an approved Pi output zone: ${artifact.path}`);
        }
        continue;
      }
      if (artifact.type === "trace") {
        if (!["kb_mission_traces", "wiki"].includes(info.pathClass)) {
          throw new Error(`trace artifact must be written to an approved trace zone: ${artifact.path}`);
        }
        continue;
      }
      if ((info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound") && await fileExists(artifact.path)) {
        throw new Error(`Hermes queue items are create-only and may not be modified in place: ${artifact.path}`);
      }
      if (!["wiki", "kb_discovery", "kb_handoff_inbound", "kb_mission_outputs"].includes(info.pathClass)) {
        throw new Error(`Hermes artifact path is not in an approved write zone: ${artifact.path}`);
      }
    }

    const missionRoots = new Set(
      task.artifacts_expected
        .map((artifact) => inferMissionRunRootFromPath(artifact.path, this.knowledgeRoots))
        .filter((value): value is string => Boolean(value)),
    );

    for (const missionRoot of missionRoots) {
      const dirs = await ensureMissionRunSkeleton({ missionRoot });
      const requestPath = join(dirs.requestDir, "request.json");
      await writeKnowledgeJson({
        actor: "pi",
        path: requestPath,
        mode: "create",
        roots: this.knowledgeRoots,
        value: task,
      });
    }
  }

  private async emitKbPreflightAllowedEvents(run: HermesBridgeRunRecord): Promise<void> {
    const task = run.v2Task;
    if (!task) return;
    const requestPath = inferMissionRunRootFromPath(task.artifacts_expected[0]?.path ?? "", this.knowledgeRoots)
      ? join(inferMissionRunRootFromPath(task.artifacts_expected[0].path, this.knowledgeRoots)!, "request", "request.json")
      : null;
    if (requestPath) {
      await this.emitV2Event(run, {
        event_type: "kb.write_allowed",
        state: run.state as PiHermesRunState,
        agent: "pi",
        message: "Mission request envelope written",
        payload: { path: requestPath, path_class: "kb_mission_request", actor: "pi" },
      });
    }
    for (const artifact of task.artifacts_expected) {
      const info = classifyKnowledgePath(artifact.path, this.knowledgeRoots);
      const eventType = info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound"
        ? "kb.queue_create"
        : "kb.write_allowed";
      await this.emitV2Event(run, {
        event_type: eventType,
        state: run.state as PiHermesRunState,
        agent: info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound" ? "hermes" : "pi",
        message: `KB policy allows artifact path: ${artifact.path}`,
        payload: { path: artifact.path, path_class: info.pathClass, artifact_type: artifact.type },
      });
    }
  }

  private streamRunEvents(req: IncomingMessage, res: ServerResponse, run: HermesBridgeRunRecord): void {
    const lastEventId = parseLastEventId(req);
    const replayEvents = getReplayEvents(run, lastEventId);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    for (const event of replayEvents) {
      writeSseEvent(res, getBridgeEventId(run, event), event);
    }

    if (isTerminalRunRecord(run)) {
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      writeSseNamedEvent(res, "heartbeat", JSON.stringify({ at: new Date().toISOString() }));
    }, 12000);

    const subscriber: SseSubscriber = {
      res,
      close: () => {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      },
      send: (eventId, event) => {
        writeSseEvent(res, eventId, event);
        if (isTerminalBridgeEvent(event)) {
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        }
      },
    };

    const set = this.subscribers.get(run.accepted.execution_id) ?? new Set<SseSubscriber>();
    set.add(subscriber);
    this.subscribers.set(run.accepted.execution_id, set);

    const cleanup = () => {
      clearInterval(heartbeat);
      const subscriberSet = this.subscribers.get(run.accepted.execution_id);
      if (!subscriberSet) return;
      subscriberSet.delete(subscriber);
      if (subscriberSet.size === 0) this.subscribers.delete(run.accepted.execution_id);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    (req.socket as Socket).on?.("error", cleanup);
  }

  private broadcastEvent(run: HermesBridgeRunRecord, event: BridgeEventRecord): void {
    const subscriberSet = this.subscribers.get(run.accepted.execution_id);
    if (!subscriberSet || subscriberSet.size === 0) return;
    const eventId = getBridgeEventId(run, event);
    for (const subscriber of Array.from(subscriberSet)) {
      subscriber.send(eventId, event);
    }
    if (isTerminalBridgeEvent(event)) this.closeSubscribers(run.accepted.execution_id);
  }

  private closeSubscribers(executionId: string): void {
    const subscriberSet = this.subscribers.get(executionId);
    if (!subscriberSet) return;
    for (const subscriber of subscriberSet) subscriber.close();
    this.subscribers.delete(executionId);
  }
}

function parsedLegacyRequest(request: HermesTaskRequest): HermesTaskRequest {
  return HermesTaskRequestSchema.parse(request);
}

function serializeRun(run: HermesBridgeRunRecord): Record<string, unknown> {
  const publicEvents = getPublicEvents(run);
  const state = getRunState(run);
  const lifecycle = {
    state,
    bridge_status: run.status,
    terminal: isTerminalRunRecord(run),
    failure_class: run.failureClass ?? null,
  };

  return {
    api_version: run.v2Task ? "v2" : "v1-compat",
    run_kind: run.v2Task ? "contract_v2" : "legacy",
    contract_version: run.v2Task ? "2.0" : null,
    execution_id: run.accepted.execution_id,
    request_id: run.accepted.request_id,
    session_id: run.accepted.session_id,
    mission_id: run.v2Task?.mission_id ?? run.request.metadata?.mission_id ?? null,
    run_id: run.v2Task?.run_id ?? run.request.metadata?.run_id ?? null,
    status: run.status,
    state,
    lifecycle,
    accepted: run.accepted,
    task_envelope: run.v2Task ?? null,
    result_envelope: run.v2Result ?? null,
    worker_result: run.result,
    result: run.v2Result ?? run.result,
    error: run.error,
    failure_class: run.failureClass ?? null,
    event_count: publicEvents.length,
    raw_event_count: run.events.length,
    events_format: run.v2Task ? "structured_v2" : "legacy",
    links: {
      events: `/runs/${run.accepted.execution_id}/events`,
      events_raw: `/runs/${run.accepted.execution_id}/events?view=raw`,
      stream: `/runs/${run.accepted.execution_id}/events?stream=1`,
    },
  };
}

function serializeLegacyRunShape(run: HermesBridgeRunRecord): Record<string, unknown> {
  return {
    execution_id: run.accepted.execution_id,
    request_id: run.accepted.request_id,
    session_id: run.accepted.session_id,
    status: run.status,
    state: getRunState(run),
    result: run.v2Result ?? run.result,
    error: run.error,
    failure_class: run.failureClass ?? null,
    event_count: getPublicEvents(run).length,
  };
}

function serializeRunEvents(run: HermesBridgeRunRecord): Record<string, unknown> {
  const items = getPublicEvents(run);
  return {
    api_version: run.v2Task ? "v2" : "v1-compat",
    run_kind: run.v2Task ? "contract_v2" : "legacy",
    contract_version: run.v2Task ? "2.0" : null,
    execution_id: run.accepted.execution_id,
    request_id: run.accepted.request_id,
    session_id: run.accepted.session_id,
    event_format: run.v2Task ? "structured_v2" : "legacy",
    count: items.length,
    items,
  };
}

function statusFromLegacyEvent(type: string): HermesTaskResult["status"] | null {
  switch (type) {
    case "task.started":
      return "accepted";
    case "task.progress":
    case "task.output":
    case "task.heartbeat":
      return "running";
    case "task.completed":
      return "completed";
    case "task.failed":
      return "failed";
    case "task.cancelled":
      return "cancelled";
    case "task.interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function writeSseEvent(res: ServerResponse, id: number, event: BridgeEventRecord): void {
  const name = getEventName(event);
  writeSseNamedEvent(res, name, JSON.stringify({ id, ...event }), id);
}

function writeSseNamedEvent(res: ServerResponse, name: string, data: string, id?: number): void {
  if (res.writableEnded) return;
  if (typeof id === "number") res.write(`id: ${id}\n`);
  res.write(`event: ${name}\n`);
  for (const line of data.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function json(res: ServerResponse, statusCode: number, value: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function getEventKind(event: BridgeEventRecord): string {
  return isStructuredV2Event(event) ? event.event_type : event.type;
}

function getEventName(event: BridgeEventRecord): string {
  return getEventKind(event);
}

function getEventPayload(event: BridgeEventRecord): Record<string, unknown> {
  return isStructuredV2Event(event) ? event.payload : event.data;
}

function isStructuredV2Event(event: BridgeEventRecord): event is PiHermesStructuredEventV2 {
  return "event_type" in event;
}

function getPublicEvents(run: HermesBridgeRunRecord): BridgeEventRecord[] {
  return run.v2Task ? run.events.filter(isStructuredV2Event) : run.events;
}

function getReplayEvents(run: HermesBridgeRunRecord, lastEventId: number): BridgeEventRecord[] {
  const publicEvents = getPublicEvents(run);
  if (!run.v2Task) return publicEvents.slice(Math.max(0, lastEventId));
  return publicEvents.filter((event) => isStructuredV2Event(event) && event.event_id > lastEventId);
}

function getBridgeEventId(run: HermesBridgeRunRecord, event: BridgeEventRecord): number {
  if (run.v2Task && isStructuredV2Event(event)) return event.event_id;
  return Math.max(1, getPublicEvents(run).indexOf(event) + 1);
}

function getRunState(run: HermesBridgeRunRecord): string {
  return run.state ?? run.status;
}

function isTerminalBridgeEvent(event: BridgeEventRecord): boolean {
  const kind = getEventKind(event);
  return kind === "task.completed"
    || kind === "task.failed"
    || kind === "task.cancelled"
    || kind === "task.interrupted"
    || kind === "run.completed"
    || kind === "run.failed"
    || kind === "run.cancelled"
    || kind === "run.interrupted"
    || kind === "run.timed_out";
}

function isTerminalRunRecord(run: HermesBridgeRunRecord): boolean {
  if (run.v2Task && run.state) return isTerminalV2State(run.state as PiHermesRunState);
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

function terminalStateToLegacyStatus(state: PiHermesRunState): HermesTaskResult["status"] {
  switch (state) {
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    case "timed_out": return "failed";
    case "failed": return "failed";
    default: return "failed";
  }
}

function requiredArtifactPath(task: PiHermesTaskEnvelopeV2, type: string): string {
  const artifact = task.artifacts_expected.find((item) => item.type === type && item.required);
  if (!artifact) throw new Error(`missing required artifact definition for type ${type}`);
  return artifact.path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function buildPlaceholderArtifact(
  artifactId: string,
  type: string,
  role: string,
  path: string,
  producedBy: string,
  description: string,
) {
  return {
    artifact_id: artifactId,
    type,
    role,
    path: resolve(path),
    sha256: null,
    size_bytes: 0,
    mime_type: path.endsWith(".json") ? "application/json" : null,
    created_at: new Date().toISOString(),
    produced_by: producedBy,
    description,
  };
}

async function refreshGeneratedArtifacts(manifest: any[], resultPath: string, manifestPath: string) {
  const refreshed = [...manifest];
  for (const item of refreshed) {
    if (item.path === resolve(resultPath) || item.path === resolve(manifestPath)) {
      try {
        const s = await stat(item.path);
        item.size_bytes = s.size;
        item.created_at = new Date(s.mtimeMs).toISOString();
      } catch {
        item.size_bytes = 0;
      }
    }
  }
  return refreshed;
}

function buildResultEnvelope(
  task: PiHermesTaskEnvelopeV2,
  run: HermesBridgeRunRecord,
  adapterResult: HermesTaskResult,
  artifactManifest: any[],
  startedAt: string,
  endedAt: string,
  failureClass: PiHermesFailureClass | null,
  errorMessage: string | null,
): PiHermesResultEnvelopeV2 {
  return PiHermesResultEnvelopeV2Schema.parse({
    schema_version: "2.0",
    request_id: task.request_id,
    run_id: task.run_id,
    mission_id: task.mission_id,
    session_id: task.session_id,
    execution_id: task.execution_id,
    status: failureClass ? "failed" : "succeeded",
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    summary: adapterResult.summary,
    result: {
      bridge_status: adapterResult.status,
      worker_structured_output: adapterResult.structured_output,
    },
    artifact_manifest: artifactManifest,
    logs_ref: {
      bridge_state_root: join(homedir(), ".pi", "hermes-bridge-state"),
      execution_id: task.execution_id,
    },
    error: failureClass ? { message: errorMessage } : null,
    failure_class: failureClass,
    next_action_needed: failureClass ? "inspect failure and rerun after fixing contract or artifacts" : null,
    metrics: {
      event_count: run.events.length,
      artifacts_produced: artifactManifest.length,
    },
    metadata: {
      hermes_session_id: run.session.hermes_session_id,
    },
  });
}

function extractStartedAt(run: HermesBridgeRunRecord): string | null {
  const first = run.events.find((event) => getEventKind(event) === "run.accepted" || getEventKind(event) === "task.started");
  if (!first) return null;
  return "timestamp" in first ? first.timestamp : first.at;
}

