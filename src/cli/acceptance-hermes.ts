#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HermesBridgeServer, detectHermes, type HermesAdapterOptions, type KnowledgeRoots } from "../hermes/index.js";
import {
  HermesDoctorCheck,
  HermesDoctorOptions,
  parseHermesDoctorArgs,
  runHermesDoctor,
} from "./hermes-doctor.js";

export interface HermesAcceptanceOptions extends HermesDoctorOptions {
  mode?: "embedded" | "external";
  command?: string;
  host?: string;
  port?: number;
  stateRoot?: string;
  adapterOptions?: HermesAdapterOptions;
}

export interface HermesAcceptanceResult {
  ok: boolean;
  mode: "embedded" | "external";
  bridgeUrl: string;
  checks: HermesDoctorCheck[];
}

export function parseHermesAcceptanceArgs(argv: string[]): HermesAcceptanceOptions {
  const base = parseHermesDoctorArgs(argv);
  const hasUrl = argv.includes("--url");
  const forceEmbedded = argv.includes("--embedded");
  const forceExternal = argv.includes("--external");

  const options: HermesAcceptanceOptions = {
    ...base,
    mode: forceEmbedded ? "embedded" : forceExternal || hasUrl ? "external" : "embedded",
    host: "127.0.0.1",
    port: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--command" && next) {
      options.command = resolve(next);
      i += 1;
    } else if (arg === "--host" && next) {
      options.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      i += 1;
    } else if (arg === "--state-root" && next) {
      options.stateRoot = resolve(next);
      i += 1;
    }
  }

  return options;
}

export async function runHermesAcceptance(options: HermesAcceptanceOptions): Promise<HermesAcceptanceResult> {
  if ((options.mode ?? "embedded") === "external") {
    const checks = await runHermesDoctor(options);
    return {
      ok: checks.every((check) => check.ok),
      mode: "external",
      bridgeUrl: options.url ?? "http://127.0.0.1:8787",
      checks,
    };
  }

  const detected = detectHermes();
  const command = options.adapterOptions?.command ?? options.command ?? detected.binaryPath;
  if (!command) {
    throw new Error("Hermes binary not found for embedded acceptance. Install Hermes, set HERMES_COMMAND, or pass --command <path>. Use --url <bridge> to target an existing external bridge instead.");
  }

  const cleanupPaths: string[] = [];
  let server: HermesBridgeServer | null = null;
  try {
    const knowledgeRoots = options.knowledgeRoots ?? await makeTempKnowledgeRoots(cleanupPaths);
    const stateRoot = options.adapterOptions?.stateRoot ?? options.stateRoot ?? await makeTempDir("pi-hermes-acceptance-state-", cleanupPaths);
    const workdir = options.workdir ?? detected.repoPath ?? await makeTempDir("pi-hermes-acceptance-work-", cleanupPaths);
    const token = options.token ?? `acceptance-${randomUUID()}`;

    server = new HermesBridgeServer({
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      authToken: token,
      stateRoot,
      knowledgeRoots,
      enforceKnowledgePolicy: false,
      adapterOptions: {
        ...options.adapterOptions,
        command,
        stateRoot,
      },
    });

    const listening = await server.start();
    const bridgeUrl = `http://${listening.host}:${listening.port}`;
    const checks = await runHermesDoctor({
      url: bridgeUrl,
      token,
      workdir,
      timeoutMs: options.timeoutMs,
      knowledgeRoots,
    });

    return {
      ok: checks.every((check) => check.ok),
      mode: "embedded",
      bridgeUrl,
      checks,
    };
  } finally {
    if (server) await server.stop();
    await Promise.all(cleanupPaths.reverse().map((path) => rm(path, { recursive: true, force: true })));
  }
}

export async function runHermesAcceptanceCli(argv: string[] = process.argv.slice(2)): Promise<HermesAcceptanceResult> {
  return runHermesAcceptance(parseHermesAcceptanceArgs(argv));
}

export function printHermesAcceptanceResult(result: HermesAcceptanceResult): void {
  console.log("Final status");
  console.log("");
  console.log(`- Hermes acceptance test: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`- mode: ${result.mode}`);
  console.log(`- bridge: ${result.bridgeUrl}`);
  console.log("");
  if (result.mode === "embedded") {
    console.log("Operational note");
    console.log("");
    console.log("- no pre-started bridge required");
    console.log("- no pre-created token file required");
    console.log("- no KB web server dependency in this helper path");
    console.log("");
  }
  console.log("Checks");
  console.log("");
  for (const check of result.checks) {
    console.log(`- ${check.ok ? "PASS" : "FAIL"}: ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }
}

async function makeTempKnowledgeRoots(cleanupPaths: string[]): Promise<KnowledgeRoots> {
  return {
    agenticKbRoot: await makeTempDir("agentic-kb-acceptance-", cleanupPaths),
    llmWikiRoot: await makeTempDir("llm-wiki-acceptance-", cleanupPaths),
  };
}

async function makeTempDir(prefix: string, cleanupPaths: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesAcceptanceCli(process.argv.slice(2)).then((result) => {
    printHermesAcceptanceResult(result);
    process.exit(result.ok ? 0 : 1);
  }).catch((error) => {
    console.error("Final status");
    console.error("");
    console.error("- Hermes acceptance test: FAIL");
    console.error("");
    console.error(String(error));
    process.exit(1);
  });
}
