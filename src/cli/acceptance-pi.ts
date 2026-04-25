#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGoldenPath } from "./run.js";
import { readTape, verifyTape } from "../replay/recorder.js";

export interface PiAcceptanceOptions {
  workdir: string;
  outRoot: string;
  tracePath?: string;
}

export interface PiAcceptanceResult {
  ok: boolean;
  sessionId: string;
  tapePath: string;
  effectLogPath: string;
  policyLogPath: string;
  checkpointPath: string;
  tracePath?: string;
  recordCount: number;
  digest?: string;
  failure?: string;
}

export function parsePiAcceptanceArgs(argv: string[]): PiAcceptanceOptions {
  const positional: string[] = [];
  let tracePath: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--trace=")) {
      tracePath = resolve(arg.slice("--trace=".length));
    } else {
      positional.push(arg);
    }
  }

  return {
    workdir: resolve(positional[0] ?? ".pi-acceptance-work"),
    outRoot: resolve(positional[1] ?? ".pi-acceptance-out"),
    tracePath,
  };
}

export async function runPiAcceptance(options: PiAcceptanceOptions): Promise<PiAcceptanceResult> {
  const sessionId = await runGoldenPath(options.workdir, options.outRoot, { tracePath: options.tracePath });
  const tapePath = join(options.outRoot, "tapes", `${sessionId}.jsonl`);
  const effectLogPath = join(options.outRoot, "effects", `${sessionId}.jsonl`);
  const policyLogPath = join(options.outRoot, "sessions", sessionId, "policy.jsonl");
  const checkpointPath = join(options.outRoot, "sessions", sessionId, "checkpoint.json");

  const verification = await verifyTape(tapePath);
  if (!verification.ok) {
    return {
      ok: false,
      sessionId,
      tapePath,
      effectLogPath,
      policyLogPath,
      checkpointPath,
      tracePath: options.tracePath,
      recordCount: 0,
      failure: verification.error,
    };
  }

  await assertExists(effectLogPath, "missing effect log");
  await assertExists(policyLogPath, "missing policy log");
  await assertExists(checkpointPath, "missing checkpoint");

  const records = await readTape(tapePath);
  return {
    ok: true,
    sessionId,
    tapePath,
    effectLogPath,
    policyLogPath,
    checkpointPath,
    tracePath: options.tracePath,
    recordCount: records.length,
    digest: verification.digest,
  };
}

async function assertExists(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

export async function runPiAcceptanceCli(argv: string[] = process.argv.slice(2)): Promise<PiAcceptanceResult> {
  return runPiAcceptance(parsePiAcceptanceArgs(argv));
}

export function printPiAcceptanceResult(result: PiAcceptanceResult): void {
  console.log("Final status");
  console.log("");
  console.log(`- Pi acceptance test: ${result.ok ? "PASS" : "FAIL"}`);
  console.log("");
  console.log("Artifacts");
  console.log("");
  console.log(`- session: ${result.sessionId}`);
  console.log(`- tape: ${result.tapePath}`);
  console.log(`- effect log: ${result.effectLogPath}`);
  console.log(`- policy log: ${result.policyLogPath}`);
  console.log(`- checkpoint: ${result.checkpointPath}`);
  if (result.tracePath) console.log(`- trace: ${result.tracePath}`);
  if (result.digest) console.log(`- digest: ${result.digest}`);
  console.log(`- tape records: ${result.recordCount}`);
  if (!result.ok && result.failure) console.log(`- failure: ${result.failure}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPiAcceptanceCli(process.argv.slice(2)).then((result) => {
    printPiAcceptanceResult(result);
    process.exit(result.ok ? 0 : 1);
  }).catch((error) => {
    console.error("Final status");
    console.error("");
    console.error("- Pi acceptance test: FAIL");
    console.error("");
    console.error(String(error));
    process.exit(1);
  });
}
