#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectHermes, ensureKnowledgeDirectorySkeleton, type KnowledgeRoots } from "../hermes/index.js";

export interface HermesDoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HermesDoctorOptions {
  url?: string;
  token?: string;
  tokenFile?: string;
  workdir?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  knowledgeRoots?: Partial<KnowledgeRoots>;
}

interface HermesMetaResponse {
  binaryPath: string | null;
  repoPath: string | null;
  authRequired: boolean;
}

interface HermesSessionResponse {
  session_id: string;
}

interface HermesAcceptedResponse {
  execution_id: string;
  status: string;
}

interface HermesRunResponse {
  status: string;
  run_kind?: string;
  result?: {
    summary: string;
  } | null;
  worker_result?: {
    summary: string;
  } | null;
  error?: string | null;
}

interface HermesEventsResponse {
  event_format: string;
  items: Array<{ type: string; data?: Record<string, unknown> }>;
}

export function parseHermesDoctorArgs(argv: string[]): HermesDoctorOptions {
  const options: HermesDoctorOptions = {
    url: "http://127.0.0.1:8787",
    tokenFile: join(homedir(), ".pi", "hermes-bridge-token"),
    timeoutMs: 120000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      options.url = next;
      i += 1;
    } else if (arg === "--token" && next) {
      options.token = next;
      i += 1;
    } else if (arg === "--token-file" && next) {
      options.tokenFile = next;
      i += 1;
    } else if (arg === "--workdir" && next) {
      options.workdir = resolve(next);
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    }
  }

  return options;
}

export async function runHermesDoctor(options: HermesDoctorOptions = {}): Promise<HermesDoctorCheck[]> {
  const checks: HermesDoctorCheck[] = [];
  const detected = detectHermes();
  const url = options.url ?? "http://127.0.0.1:8787";
  const tokenFile = options.tokenFile ?? join(homedir(), ".pi", "hermes-bridge-token");
  const timeoutMs = options.timeoutMs ?? 120000;
  const token = options.token ?? process.env.PI_HERMES_BRIDGE_TOKEN ?? await readTokenFile(tokenFile);
  const workdir = options.workdir ?? detected.repoPath ?? process.cwd();
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  checks.push({
    name: "detected Hermes binary path",
    ok: Boolean(detected.binaryPath),
    detail: detected.binaryPath ?? "not found",
  });
  checks.push({
    name: "detected Hermes repo path",
    ok: Boolean(detected.repoPath),
    detail: detected.repoPath ?? "not found",
  });
  checks.push({
    name: "bridge token available",
    ok: Boolean(token),
    detail: token ? tokenFile : "missing token/env",
  });

  const healthResponse = await fetch(`${url}/healthz`);
  const healthJson = await healthResponse.json() as { ok?: boolean };
  checks.push({
    name: "bridge healthz reachable",
    ok: healthResponse.ok && Boolean(healthJson.ok),
    detail: `${healthResponse.status}`,
  });

  const unauthorizedMeta = await fetch(`${url}/meta`);
  checks.push({
    name: "bridge auth enforced",
    ok: unauthorizedMeta.status === 401,
    detail: `${unauthorizedMeta.status}`,
  });

  if (!token) return checks;

  const authHeaders = { Authorization: `Bearer ${token}` };
  const metaResponse = await fetch(`${url}/meta`, { headers: authHeaders });
  const meta = await metaResponse.json() as HermesMetaResponse;
  checks.push({
    name: "authorized meta works",
    ok: metaResponse.ok,
    detail: `${metaResponse.status}`,
  });
  checks.push({
    name: "bridge reports auth required",
    ok: meta.authRequired === true,
    detail: String(meta.authRequired),
  });
  checks.push({
    name: "bridge binary matches detected Hermes binary",
    ok: meta.binaryPath === detected.binaryPath,
    detail: meta.binaryPath ?? "null",
  });
  checks.push({
    name: "bridge repo matches detected Hermes repo",
    ok: meta.repoPath === detected.repoPath,
    detail: meta.repoPath ?? "null",
  });

  const knowledgeRoots = await ensureKnowledgeDirectorySkeleton(options.knowledgeRoots);
  const outputDir = await mkdtemp(join(knowledgeRoots.llmWikiRoot, "inbox", "pi-hermes-doctor-"));
  try {
    const sessionResponse = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workdir }),
    });
    const session = await sessionResponse.json() as HermesSessionResponse;
    checks.push({
      name: "bridge session creation works",
      ok: sessionResponse.ok && Boolean(session.session_id),
      detail: session.session_id ?? `${sessionResponse.status}`,
    });

    const executeResponse = await fetch(`${url}/execute`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: "req_hermes_doctor",
        session_id: session.session_id,
        objective: `Create ${join(outputDir, "doctor.md")} with one sentence confirming Hermes doctor succeeded, then return the required structured result block only. Do not modify any other files.`,
        workdir,
        allowed_tools: ["bash"],
        allowed_actions: ["write"],
        timeout_seconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
        output_dir: outputDir,
        metadata: {
          mission_id: "hermes-doctor",
          run_id: "doctor-run",
          step_id: "doctor-step",
        },
      }),
    });
    const accepted = await executeResponse.json() as HermesAcceptedResponse;
    checks.push({
      name: "bridge execute accepted",
      ok: executeResponse.status === 202 && accepted.status === "accepted",
      detail: accepted.execution_id ?? `${executeResponse.status}`,
    });

    const deadline = Date.now() + timeoutMs;
    let run: HermesRunResponse | null = null;
    while (Date.now() < deadline) {
      const runResponse = await fetch(`${url}/runs/${accepted.execution_id}`, { headers: authHeaders });
      run = await runResponse.json() as HermesRunResponse;
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) break;
      await sleep(pollIntervalMs);
    }

    checks.push({
      name: "bridge execute smoke test completes",
      ok: run?.status === "completed",
      detail: run?.status ?? "timeout",
    });

    const eventsResponse = await fetch(`${url}/runs/${accepted.execution_id}/events`, { headers: authHeaders });
    const events = await eventsResponse.json() as HermesEventsResponse;
    const transportEvent = events.items.find((event) => event.type === "task.progress" && event.data?.transport);
    checks.push({
      name: "transport is PTY",
      ok: transportEvent?.data?.transport === "pty",
      detail: String(transportEvent?.data?.transport ?? "missing"),
    });
    checks.push({
      name: "PTY backend detected",
      ok: typeof transportEvent?.data?.transport_backend === "string",
      detail: String(transportEvent?.data?.transport_backend ?? "missing"),
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  return checks;
}

async function readTokenFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function runHermesDoctorCli(argv: string[] = process.argv.slice(2)): Promise<HermesDoctorCheck[]> {
  return runHermesDoctor(parseHermesDoctorArgs(argv));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesDoctorCli(process.argv.slice(2)).then((checks) => {
    for (const check of checks) {
      console.log(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
    process.exit(checks.every((check) => check.ok) ? 0 : 1);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
