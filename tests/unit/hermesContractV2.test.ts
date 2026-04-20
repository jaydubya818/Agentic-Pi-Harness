import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertValidStateTransition } from "../../src/hermes/contractV2.js";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("PI_HERMES_CONTRACT_V2 golden mission", () => {
  it("runs successfully and produces valid contract artifacts", async () => {
    const workdir = await makeTempDir("pi-hermes-v2-work-");
    const artifactRoot = await makeTempDir("pi-hermes-v2-artifacts-");
    const stateRoot = await makeTempDir("pi-hermes-v2-state-");
    const server = createContractServer(stateRoot);
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const { sessionId } = await createSession(base, workdir);
      const executionId = await executeGoldenMission(base, sessionId, artifactRoot, "happy path golden mission");
      const run = await waitForRun(base, executionId);

      expect(run.api_version).toBe("v2");
      expect(run.run_kind).toBe("contract_v2");
      expect(run.events_format).toBe("structured_v2");
      expect(run.lifecycle.state).toBe("succeeded");
      expect(run.state).toBe("succeeded");
      expect(run.failure_class).toBeNull();
      expect(run.result.status).toBe("succeeded");
      expect(run.result.schema_version).toBe("2.0");
      expect(run.result_envelope.schema_version).toBe("2.0");
      expect(run.task_envelope.schema_version).toBe("2.0");
      expect(run.result.artifact_manifest).toHaveLength(4);
      expect(await fileText(join(artifactRoot, "summary.md"))).toContain("Golden Mission Summary");
      expect(JSON.parse(await fileText(join(artifactRoot, "result.json"))).schema_version).toBe("2.0");
      expect(JSON.parse(await fileText(join(artifactRoot, "artifact-manifest.json"))).length).toBe(4);
      expect(JSON.parse(await fileText(join(artifactRoot, "trace.json"))).schema_version).toBe("2.0");

      const eventsResponse = await fetch(`${base}/runs/${executionId}/events`);
      const events = await eventsResponse.json();
      expect(events.event_format).toBe("structured_v2");
      expect(events.items.length).toBeGreaterThan(0);
      expect(events.items.every((event: Record<string, unknown>) => typeof event.event_type === "string")).toBe(true);
      expect(events.items.some((event: Record<string, unknown>) => event.event_type === "run.completed")).toBe(true);

      const rawEventsResponse = await fetch(`${base}/runs/${executionId}/events?view=raw`);
      const rawEvents = await rawEventsResponse.json();
      expect(rawEvents.some((event: Record<string, unknown>) => event.type === "task.started")).toBe(true);
      expect(rawEvents.some((event: Record<string, unknown>) => event.event_type === "run.completed")).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("fails clearly when a required artifact is missing", async () => {
    const workdir = await makeTempDir("pi-hermes-v2-work-");
    const artifactRoot = await makeTempDir("pi-hermes-v2-artifacts-");
    const stateRoot = await makeTempDir("pi-hermes-v2-state-");
    const server = createContractServer(stateRoot);
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const { sessionId } = await createSession(base, workdir);
      const executionId = await executeGoldenMission(base, sessionId, artifactRoot, "__MISSING_ARTIFACT__ omit required summary");
      const run = await waitForRun(base, executionId);

      expect(run.state).toBe("failed");
      expect(run.failure_class).toBe("artifact_error");
      expect(run.result.failure_class).toBe("artifact_error");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("rejects invalid lifecycle state transitions", () => {
    expect(() => assertValidStateTransition("accepted", "succeeded")).toThrow(/invalid state transition/);
  });

  it("fails a stuck run when semantic heartbeat is missing", async () => {
    const workdir = await makeTempDir("pi-hermes-v2-work-");
    const artifactRoot = await makeTempDir("pi-hermes-v2-artifacts-");
    const stateRoot = await makeTempDir("pi-hermes-v2-state-");
    const server = createContractServer(stateRoot, { emitSemanticHeartbeats: false, stuckTimeoutMs: 600 });
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const { sessionId } = await createSession(base, workdir);
      const executionId = await executeGoldenMission(base, sessionId, artifactRoot, "__STUCK__ simulate hung worker");
      const run = await waitForRun(base, executionId, 10000);

      expect(run.state).toBe("failed");
      expect(run.failure_class).toBe("stuck_run");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("fails malformed worker result payloads as contract errors", async () => {
    const workdir = await makeTempDir("pi-hermes-v2-work-");
    const artifactRoot = await makeTempDir("pi-hermes-v2-artifacts-");
    const stateRoot = await makeTempDir("pi-hermes-v2-state-");
    const server = createContractServer(stateRoot);
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const { sessionId } = await createSession(base, workdir);
      const executionId = await executeGoldenMission(base, sessionId, artifactRoot, "__MALFORMED_RESULT__ malformed payload");
      const run = await waitForRun(base, executionId);

      expect(run.state).toBe("failed");
      expect(run.failure_class).toBe("contract_error");
    } finally {
      await server.stop();
    }
  }, 20000);
});

function createContractServer(stateRoot: string, overrides: Partial<ConstructorParameters<typeof HermesBridgeServer>[0]> = {}) {
  return new HermesBridgeServer({
    host: "127.0.0.1",
    port: 0,
    stateRoot,
    enforceKnowledgePolicy: false,
    heartbeatIntervalMs: 200,
    stuckTimeoutMs: 1500,
    adapterOptions: {
      command: process.execPath,
      commandArgsPrefix: [resolve("tests/fixtures/fake-hermes-contract-v2.mjs")],
      preferTransport: "subprocess",
      stateRoot,
    },
    ...overrides,
  });
}

async function createSession(base: string, workdir: string): Promise<{ sessionId: string }> {
  const response = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workdir }),
  });
  const session = await response.json() as { session_id: string };
  return { sessionId: session.session_id };
}

async function executeGoldenMission(base: string, sessionId: string, artifactRoot: string, marker: string): Promise<string> {
  const body = {
    schema_version: "2.0",
    request_id: `req_${Date.now()}`,
    run_id: `run_${Date.now()}`,
    mission_id: `mission_${Date.now()}`,
    session_id: sessionId,
    execution_id: `exec_${Date.now()}`,
    task_type: "repo_inspection",
    goal: `Golden mission ${marker}`,
    instructions: [
      marker,
      "Inspect the repo in isolated worktree semantics.",
      "Produce the required golden mission artifacts.",
    ],
    constraints: {
      network_access: false,
      write_access: true,
      path_allowlist: [artifactRoot],
      path_denylist: [],
      side_effect_class: "local_write",
      requires_isolation: true,
    },
    allowed_tools: ["bash"],
    disallowed_tools: [],
    workdir: artifactRoot,
    repo: {
      root: artifactRoot,
      vcs: "git",
      worktree_path: artifactRoot,
    },
    branch: "pi/test",
    timeout_seconds: 20,
    budget: {
      max_tool_calls: 5,
      max_runtime_seconds: 10,
    },
    artifacts_expected: [
      {
        type: "summary",
        role: "primary_result",
        path: join(artifactRoot, "summary.md"),
        required: true,
      },
      {
        type: "result",
        role: "primary_result",
        path: join(artifactRoot, "result.json"),
        required: true,
      },
      {
        type: "manifest",
        role: "primary_result",
        path: join(artifactRoot, "artifact-manifest.json"),
        required: true,
      },
      {
        type: "trace",
        role: "supporting_log",
        path: join(artifactRoot, "trace.json"),
        required: true,
      },
    ],
    approval_policy: {
      mode: "never",
      allow_interrupt: true,
      allow_cancel: true,
    },
    priority: "normal",
    metadata: {
      step_id: "step-1",
    },
  };

  const response = await fetch(`${base}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const accepted = await response.json() as { execution_id: string };
  return accepted.execution_id;
}

async function waitForRun(base: string, executionId: string, timeoutMs = 15000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/runs/${executionId}`);
    const run = await response.json();
    if (["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.state)) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`timed out waiting for run ${executionId}`);
}

async function fileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
