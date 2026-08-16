import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { timingSafeEqual } from "node:crypto";
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
import { assertSafeStateIdSegment, HermesBridgeStateStore, type BridgeEventRecord, type BridgeStateRunRecord } from "./bridgeState.js";

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
  private stopPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, HermesAdapterSession>();
  private readonly runs = new Map<string, HermesBridgeRunRecord>();
  private readonly activeWatchers = new Set<Promise<void>>();
  private readonly subscribers = new Map<string, Set<SseSubscriber>>();
  private readonly heartbeatControllers = new Map<string, ActiveHeartbeatController>();
  private readonly nextV2EventIds = new WeakMap<HermesBridgeRunRecord, number>();

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
    // /sessions and /execute let callers spawn worker processes with a
    // caller-chosen workdir and environment. Exposing that beyond loopback
    // without bearer auth is unauthenticated remote command execution (the
    // dominant 2026 MCP-ecosystem CVE pattern), so fail closed at startup.
    if (!this.authToken && !isLoopbackHost(this.host)) {
      throw new Error(
        `refusing to bind HermesBridgeServer to non-loopback host ${this.host} without an auth token; `
        + "configure authToken (CLI: --auth-token or PI_HERMES_BRIDGE_TOKEN) to expose the bridge beyond localhost",
      );
    }

    await mkdir(this.stateRoot, { recursive: true });
    if (this.enforceKnowledgePolicy) await ensureKnowledgeDirectorySkeleton(this.knowledgeRoots);
    await this.stateStore.init();
    const snapshot = await this.stateStore.load();
    for (const session of snapshot.sessions) this.sessions.set(session.session_id, session);
    for (const run of snapshot.runs) this.runs.set(run.accepted.execution_id, run);
    await this.reconcileRestoredRuns();

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (error instanceof BridgeRequestError) {
          this.logger.log("warn", "hermes.bridge.bad_request", { error: error.message });
          json(res, error.statusCode, { error: error.message });
          return;
        }
        this.logger.log("error", "hermes.bridge.unhandled", { error: String(error) });
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    // Node's defaults let a slow or wedged client hold a connection open for
    // 60s of header silence and 300s of body dribble. The bridge is a
    // long-lived loopback service on constrained hardware where every held
    // socket is a real cost, and every legitimate request here is a small
    // JSON body (readJson caps it at 4 MiB) from a local caller. Bound the
    // receive side so a stuck client cannot park a connection. Response
    // duration is not covered by requestTimeout, so long-lived SSE event
    // streams are unaffected.
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;

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
    // Concurrent stops (e.g. a second SIGINT while the CLI shutdown is
    // draining watchers) must join the in-flight stop: re-entering would
    // call server.close() on an already-closing server and reject with
    // ERR_SERVER_NOT_RUNNING out of an unawaited signal handler.
    if (!this.stopPromise) {
      // Cleared on settle either way: a failed stop must stay retryable.
      this.stopPromise = this.doStop().finally(() => {
        this.stopPromise = null;
      });
    }
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    for (const controller of this.heartbeatControllers.values()) controller.stop();
    this.heartbeatControllers.clear();
    // Cancel in-flight executions before draining watchers. stop() awaits
    // active watchers below; without cancellation a long-running worker
    // (default budget 900s) keeps shutdown hanging until operators kill -9
    // the bridge and orphan the worker process anyway.
    for (const run of this.runs.values()) {
      if (isTerminalRunRecord(run)) continue;
      try {
        await this.adapter.cancel(run.session.session_id, run.accepted.execution_id);
      } catch {
        // session may already be gone; watcher settlement below still holds
      }
    }
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

  /**
   * Runs restored from disk have no live adapter execution behind them: the
   * worker process died with the previous bridge process. Without this they
   * would report "running" forever. Mark them terminal so callers see an
   * honest failure instead of a run that never finishes.
   */
  private async reconcileRestoredRuns(): Promise<void> {
    for (const run of this.runs.values()) {
      if (isTerminalRunRecord(run)) continue;
      const message = "bridge restarted while execution was in flight";
      if (run.v2Task) {
        await this.failV2Run(run, "failed", "transport_error", message);
      } else {
        run.status = "failed";
        run.error = message;
        await this.stateStore.persistRun(run);
      }
      this.logger.log("warn", "hermes.bridge.run_orphaned_by_restart", {
        executionId: run.accepted.execution_id,
      });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.authToken) return true;
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const expected = Buffer.from(`Bearer ${this.authToken}`, "utf8");
    const actual = Buffer.from(header, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
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
      // The denial log is append-only and unbounded on a long-lived bridge;
      // ?limit=N lets operators tail the most recent records instead of
      // shipping the whole history on every poll. The limit is pushed down
      // into the store so a tail request also stops *reading* the whole log.
      const limit = parseLimitParam(url);
      const denials = await this.stateStore.loadPreflightDenials(limit ?? undefined);
      json(res, 200, limit === null ? denials : denials.slice(-limit));
      return;
    }

    if (method === "GET" && path === "/sessions") {
      // POST /sessions creates them and POST /sessions/:id/close releases
      // them, but there was no way to see what a long-lived bridge is
      // holding: an operator chasing a leaked idle session (or a 409 from
      // close) had to read the state root off disk. Mirrors GET /runs,
      // including ?limit=N to tail the most recent.
      const limit = parseLimitParam(url);
      // Map insertion order is creation order (restored sessions first).
      const items = Array.from(this.sessions.values());
      json(res, 200, {
        count: items.length,
        items: limit === null ? items : items.slice(-limit),
      });
      return;
    }

    if (method === "POST" && path === "/sessions") {
      const body = await readJson<StartSessionBody>(req);
      if (typeof body.workdir !== "string" || body.workdir.length === 0) {
        throw new BridgeRequestError(400, "workdir must be a non-empty string");
      }
      if (body.env !== undefined) {
        // Spreading a non-object (a string spreads its indexed characters,
        // an array its elements) would silently poison the worker's
        // environment with numeric-key garbage instead of failing.
        if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
          throw new BridgeRequestError(400, "env must be an object mapping names to string values");
        }
        for (const [name, value] of Object.entries(body.env)) {
          if (typeof value !== "string") {
            throw new BridgeRequestError(400, `env value for ${JSON.stringify(name)} must be a string`);
          }
        }
      }
      if (body.profile !== undefined && (typeof body.profile !== "string" || body.profile.length === 0)) {
        throw new BridgeRequestError(400, "profile must be a non-empty string");
      }
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
          if (error instanceof BridgePostAcceptError) {
            json(res, 500, { error: error.message });
            return;
          }
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
        if (error instanceof BridgePostAcceptError) {
          json(res, 500, { error: error.message });
          return;
        }
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
      assertExecutionIdBody(body);
      const run = this.runs.get(body.execution_id);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${body.execution_id}` });
        return;
      }
      if (isTerminalRunRecord(run)) {
        json(res, 409, { error: `execution already terminal: ${body.execution_id}`, status: run.status });
        return;
      }
      await this.adapter.interrupt(run.session.session_id, run.accepted.execution_id);
      json(res, 202, { execution_id: body.execution_id, status: "interrupted" });
      return;
    }

    if (method === "POST" && path === "/cancel") {
      const body = await readJson<{ execution_id: string }>(req);
      assertExecutionIdBody(body);
      const run = this.runs.get(body.execution_id);
      if (!run) {
        json(res, 404, { error: `unknown execution_id: ${body.execution_id}` });
        return;
      }
      if (isTerminalRunRecord(run)) {
        json(res, 409, { error: `execution already terminal: ${body.execution_id}`, status: run.status });
        return;
      }
      await this.adapter.cancel(run.session.session_id, run.accepted.execution_id);
      json(res, 202, { execution_id: body.execution_id, status: "cancelled" });
      return;
    }

    const sessionCloseMatch = path.match(/^\/sessions\/([^/]+)\/close$/);
    if (method === "POST" && sessionCloseMatch) {
      const sessionId = sessionCloseMatch[1];
      const session = this.sessions.get(sessionId);
      if (!session) {
        json(res, 404, { error: `unknown session_id: ${sessionId}` });
        return;
      }
      for (const run of this.runs.values()) {
        if (run.session.session_id === sessionId && !isTerminalRunRecord(run)) {
          json(res, 409, { error: `session has a non-terminal execution: ${run.accepted.execution_id}`, execution_id: run.accepted.execution_id });
          return;
        }
      }
      try {
        await this.adapter.close_session(sessionId);
      } catch {
        // The adapter may not know this session (e.g. the record was
        // restored from disk after a bridge restart and the adapter
        // process is new); bridge bookkeeping still applies.
      }
      session.status = "closed";
      await this.stateStore.persistSession(session);
      this.sessions.delete(sessionId);
      this.logger.log("info", "hermes.bridge.session_closed", { sessionId });
      json(res, 200, { session_id: sessionId, status: "closed" });
      return;
    }

    if (method === "GET" && path === "/runs") {
      // Operators previously had no way to enumerate runs over HTTP: run
      // ids had to come from out-of-band records or the state root on
      // disk. Summaries only (no events or envelopes) keep the payload
      // small on a long-lived bridge; ?limit=N tails the most recent.
      const limit = parseLimitParam(url);
      // Map insertion order is acceptance order (restored runs first).
      const items = Array.from(this.runs.values()).map((run) => serializeRunSummary(run));
      json(res, 200, {
        count: items.length,
        items: limit === null ? items : items.slice(-limit),
      });
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

  /**
   * Run records are keyed by execution_id in memory and on disk. Accepting a
   * caller-supplied id that already exists (a client retry, or a collision
   * from another session) would silently overwrite the existing run record
   * in `this.runs` and interleave its persisted event log with the old run.
   */
  private assertNewExecutionId(executionId: string): void {
    if (this.runs.has(executionId)) {
      throw new Error(`duplicate execution_id: ${executionId}`);
    }
  }

  private async executeLegacy(request: HermesTaskRequest) {
    const session = this.sessions.get(request.session_id);
    if (!session) throw new Error(`unknown session_id: ${request.session_id}`);
    if (request.execution_id) {
      assertSafeStateIdSegment(request.execution_id, "execution_id");
      this.assertNewExecutionId(request.execution_id);
    }
    if (this.enforceKnowledgePolicy) {
      const info = classifyKnowledgePath(request.output_dir, this.knowledgeRoots);
      if (!["wiki", "kb_discovery", "kb_handoff_inbound", "kb_mission_outputs"].includes(info.pathClass)) {
        throw new Error(`legacy Hermes output_dir is not in an approved Hermes write zone: ${request.output_dir}`);
      }
    }
    const accepted = await this.adapter.send_task(request.session_id, request);
    try {
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
    } catch (error) {
      throw await this.releaseFailedAccept(session.session_id, accepted.execution_id, error);
    }
  }

  private async executeV2(task: PiHermesTaskEnvelopeV2) {
    const session = this.sessions.get(task.session_id);
    if (!session) throw new Error(`unknown session_id: ${task.session_id}`);
    assertSafeStateIdSegment(task.execution_id, "execution_id");
    this.assertNewExecutionId(task.execution_id);

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
    try {
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
    } catch (error) {
      throw await this.releaseFailedAccept(task.session_id, accepted.execution_id, error);
    }
  }

  /**
   * A failure between send_task and watcher start (persist, event emit)
   * previously left a live worker with nothing supervising it: the caller
   * got a 400 "preflight denied" while the phantom run record stayed
   * "accepted" forever, wedging the session (close answers 409) and the
   * execution id. Best-effort cancel the worker, drop the phantom record,
   * and surface the failure as a bridge error instead of a denial.
   */
  private async releaseFailedAccept(sessionId: string, executionId: string, error: unknown): Promise<BridgePostAcceptError> {
    try {
      await this.adapter.cancel(sessionId, executionId);
    } catch {
      // the worker may already be gone; dropping the record below is the
      // part that unwedges the session either way
    }
    this.runs.delete(executionId);
    this.logger.log("error", "hermes.bridge.post_accept_failure", {
      executionId,
      error: String(error),
    });
    return new BridgePostAcceptError(
      `bridge failed to record accepted execution ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  private async watchRun(run: HermesBridgeRunRecord): Promise<void> {
    const heartbeatController = run.v2Task ? this.startHeartbeat(run) : null;
    if (heartbeatController) this.heartbeatControllers.set(run.accepted.execution_id, heartbeatController);

    try {
      for await (const event of this.adapter.read_events(run.session.session_id, run.accepted.execution_id)) {
        run.events.push(event);
        const status = statusFromLegacyEvent(event.type);
        const statusChanged = status !== null && status !== run.status;
        if (status) run.status = status;
        await this.stateStore.appendRunEvent(run.accepted.execution_id, event);
        if (run.v2Task) {
          await this.handleV2AdapterEvent(run, event);
        } else {
          // run.json only carries the status snapshot here (the event itself
          // was appended to events.jsonl above, and result/error are
          // persisted after the loop), so rewriting it for every worker
          // output line is a redundant write+fsync+rename+dirsync cycle:
          // every task.output maps to "running". Persist on transitions.
          if (statusChanged) await this.stateStore.persistRun(run);
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
    (run as HermesBridgeRunRecord & { __lastProgressAt?: number }).__lastProgressAt = Date.now();

    const heartbeatTick = setInterval(() => {
      void (async () => {
        if (stopped || !run.v2Task) return;
        if (run.state !== "running" && run.state !== "starting") return;
        if (this.emitSemanticHeartbeats) {
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
      })().catch((error) => {
        // A failed heartbeat emit must not flip the shared `stopped` flag:
        // that silently disabled the stuck-run watchdog (and all future
        // heartbeats) after one transient persist error. Log and keep going.
        this.logger.log("warn", "hermes.bridge.heartbeat_emit_failed", {
          executionId: run.accepted.execution_id,
          error: String(error),
        });
      });
    }, this.heartbeatIntervalMs);

    const stuckTick = setInterval(() => {
      void (async () => {
        if (stopped || !run.v2Task) return;
        if (run.state !== "running" && run.state !== "starting") return;
        const lastProgressAt = (run as HermesBridgeRunRecord & { __lastProgressAt?: number }).__lastProgressAt ?? 0;
        if (Date.now() - lastProgressAt < this.stuckTimeoutMs) return;
        stopped = true;
        try {
          await this.adapter.cancel(run.session.session_id, run.accepted.execution_id);
        } catch {
          // The session or worker may already be gone; the run must still be
          // settled as stuck below instead of staying non-terminal forever.
        }
        await this.failV2Run(run, "failed", "stuck_run", "semantic heartbeat missing beyond supervisor threshold");
      })().catch((error) => {
        this.logger.log("error", "hermes.bridge.stuck_watchdog_failed", {
          executionId: run.accepted.execution_id,
          error: String(error),
        });
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
      case "task.failed": {
        const payload = getEventPayload(event);
        if (payload.timed_out === true) {
          await this.failV2Run(run, "timed_out", "timeout", String(payload.error ?? "worker timed out"));
        } else {
          await this.failV2Run(run, "failed", "execution_error", "worker reported task failure");
        }
        break;
      }
      case "task.cancelled":
        await this.failV2Run(run, "cancelled", "execution_error", "worker reported cancellation");
        break;
      case "task.interrupted":
        await this.failV2Run(run, "interrupted", "execution_error", "worker reported interruption");
        break;
      default:
        // No structured event to emit; run.json is not rewritten here. The
        // only in-memory change on these branches is legacy status
        // bookkeeping, which rides the next persisting emit (and restart
        // reconciliation settles non-terminal runs regardless).
        break;
    }
  }

  private async finalizeV2Run(run: HermesBridgeRunRecord, adapterResult: HermesTaskResult): Promise<void> {
    const task = run.v2Task;
    if (!task) return;

    if (adapterResult.timed_out) {
      await this.failV2Run(run, "timed_out", "timeout", adapterResult.error ?? "worker timed out");
      return;
    }

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
      const exists = await isRegularFile(expected.path);
      if (!exists && expected.required && expected.type !== "result" && expected.type !== "manifest") {
        failureClass = "artifact_error";
        errorMessage = `required artifact missing or not a regular file: ${expected.path}`;
      }
    }

    for (const expected of task.artifacts_expected.filter((item) => item.type !== "result" && item.type !== "manifest")) {
      if (!(await isRegularFile(expected.path))) continue;
      const info = classifyKnowledgePath(expected.path, this.knowledgeRoots);
      if (info.requiresFrontmatter) {
        let content: string;
        try {
          content = await readFile(expected.path, "utf8");
        } catch (error) {
          // An unreadable artifact must settle as a classified artifact
          // failure with a proper result envelope, not abort the whole
          // finalize pass into a generic execution_error with no envelope.
          failureClass = "artifact_error";
          errorMessage = `artifact unreadable: ${expected.path}: ${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
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
      let item: Awaited<ReturnType<typeof computeArtifactManifestItem>>;
      try {
        item = await computeArtifactManifestItem({
          artifactId: `art_${expected.type}_${manifestItems.length + 1}`,
          type: expected.type,
          role: expected.role,
          path: expected.path,
          producedBy: expected.type === "trace" ? "pi" : "hermes",
          description: expected.description,
        });
      } catch (error) {
        failureClass = "artifact_error";
        errorMessage = `artifact manifest computation failed: ${expected.path}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
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

    const resultPath = requiredArtifactPath(task, "result");
    const manifestPath = requiredArtifactPath(task, "manifest");
    const placeholderResultItem = await buildPlaceholderArtifact("art_result_1", "result", "primary_result", resultPath, "pi", "Structured result envelope");
    const placeholderManifestItem = await buildPlaceholderArtifact("art_manifest_1", "manifest", "primary_result", manifestPath, "pi", "Artifact manifest");
    let artifactManifest = [...manifestItems, placeholderResultItem, placeholderManifestItem];

    let resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, now.toISOString(), failureClass, errorMessage, this.stateRoot);
    await writeJsonArtifact(resultPath, resultEnvelope);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    await writeJsonArtifact(manifestPath, artifactManifest);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, new Date().toISOString(), failureClass, errorMessage, this.stateRoot);
    await writeJsonArtifact(resultPath, resultEnvelope);
    artifactManifest = await refreshGeneratedArtifacts(artifactManifest, resultPath, manifestPath);
    await writeJsonArtifact(manifestPath, artifactManifest);
    resultEnvelope = buildResultEnvelope(task, run, adapterResult, artifactManifest, startedAt, new Date().toISOString(), failureClass, errorMessage, this.stateRoot);
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
    // emitV2Event persists the run after appending the event, and run.state
    // is already updated above, so no second persist is needed here.
    await this.emitV2Event(run, {
      ...event,
      state: next,
    });
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
    const nextEventId = this.nextV2EventIds.get(run) ?? countStructuredV2Events(run.events) + 1;
    this.nextV2EventIds.set(run, nextEventId + 1);
    const event = PiHermesStructuredEventV2Schema.parse({
      event_id: nextEventId,
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
    const replayEvents = getReplayEventsWithIds(run, lastEventId);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    for (const { id, event } of replayEvents) {
      writeSseEvent(res, id, event);
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
    // v2 events carry their id; legacy events are always broadcast right
    // after being pushed, so their id is the current event count.
    const eventId = isStructuredV2Event(event) ? event.event_id : run.events.length;
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const v4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(\.\d{1,3}){3}$/.test(v4);
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

function serializeRunSummary(run: HermesBridgeRunRecord): Record<string, unknown> {
  return {
    execution_id: run.accepted.execution_id,
    request_id: run.accepted.request_id,
    session_id: run.accepted.session_id,
    mission_id: run.v2Task?.mission_id ?? run.request.metadata?.mission_id ?? null,
    run_id: run.v2Task?.run_id ?? run.request.metadata?.run_id ?? null,
    run_kind: run.v2Task ? "contract_v2" : "legacy",
    status: run.status,
    state: getRunState(run),
    terminal: isTerminalRunRecord(run),
    failure_class: run.failureClass ?? null,
    error: run.error,
    links: {
      run: `/runs/${run.accepted.execution_id}`,
      events: `/runs/${run.accepted.execution_id}/events`,
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

/**
 * Shared `?limit=N` tail parameter for the list endpoints. Returns null when
 * the caller did not ask for a limit (send everything).
 */
function parseLimitParam(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new BridgeRequestError(400, `limit must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
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

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function assertExecutionIdBody(body: { execution_id?: unknown }): void {
  if (typeof body.execution_id !== "string" || body.execution_id.length === 0) {
    throw new BridgeRequestError(400, "execution_id must be a non-empty string");
  }
}

/**
 * A failure *after* the adapter accepted the task (persist, event emit) is
 * not a preflight denial: the worker is already running. Distinguish it so
 * the /execute handler answers 500 instead of recording a bogus denial.
 */
class BridgePostAcceptError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "BridgePostAcceptError";
  }
}

class BridgeRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new BridgeRequestError(413, `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (error) {
    throw new BridgeRequestError(400, `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function getReplayEventsWithIds(run: HermesBridgeRunRecord, lastEventId: number): Array<{ id: number; event: BridgeEventRecord }> {
  if (!run.v2Task) {
    const skipped = Math.max(0, lastEventId);
    return run.events.slice(skipped).map((event, index) => ({ id: skipped + index + 1, event }));
  }
  return run.events
    .filter((event): event is PiHermesStructuredEventV2 => isStructuredV2Event(event) && event.event_id > lastEventId)
    .map((event) => ({ id: event.event_id, event }));
}

function countStructuredV2Events(events: BridgeEventRecord[]): number {
  let count = 0;
  for (const event of events) if (isStructuredV2Event(event)) count += 1;
  return count;
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

/**
 * Artifact finalization only accepts regular files: a directory (or socket,
 * fifo) at an expected artifact path previously passed the bare stat()
 * existence check and then blew up readFile() mid-finalize, aborting the
 * whole pass as execution_error with no result envelope written at all.
 */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
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
  bridgeStateRoot: string,
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
      bridge_state_root: bridgeStateRoot,
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

