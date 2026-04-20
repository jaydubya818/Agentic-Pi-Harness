#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { runHermesBridgeCli } from "./hermes-bridge.js";
import { runHermesDemo } from "./hermes-demo.js";
import { runHermesDoctorCli } from "./hermes-doctor.js";
import { runHermesRunCli } from "./hermes-run.js";
import { runHermesSmoke } from "./hermes-smoke.js";
import { inspectPolicy } from "./inspect.js";
import { replayTape } from "./replay.js";
import { parseRunCliArgs, runGoldenPath } from "./run.js";
import { verifyTape } from "./verify.js";
import { whatChanged } from "./what-changed.js";

function requireArg(value: string | undefined, usage: string): string {
  if (value) return value;
  console.error(usage);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "doctor": {
      const checks = await doctor();
      for (const check of checks) {
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? " (" + check.detail + ")" : ""}`);
      }
      process.exit(checks.every((check) => check.ok) ? 0 : 1);
    }
    case "hermes-demo": {
      await runHermesDemo(rest);
      return;
    }
    case "hermes-smoke": {
      await runHermesSmoke(rest);
      return;
    }
    case "hermes-run": {
      await runHermesRunCli(rest);
      return;
    }
    case "hermes-bridge": {
      await runHermesBridgeCli(rest);
      return;
    }
    case "hermes-doctor": {
      const checks = await runHermesDoctorCli(rest);
      for (const check of checks) {
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? " (" + check.detail + ")" : ""}`);
      }
      process.exit(checks.every((check) => check.ok) ? 0 : 1);
    }
    case "run": {
      const parsed = await parseRunCliArgs(rest);
      const id = await runGoldenPath(parsed.workdir, parsed.outRoot, { tracePath: parsed.tracePath });
      console.log("session " + id);
      if (parsed.tracePath) console.log("trace " + parsed.tracePath);
      return;
    }
    case "verify": {
      const tapePath = requireArg(rest[0], "usage: pi-harness verify <tape.jsonl>");
      const result = await verifyTape(tapePath);
      if (result.ok) {
        console.log(`ok ${result.records} records digest=${result.digest}`);
        return;
      }
      console.error(`FAIL: ${result.error}`);
      process.exit(1);
    }
    case "what-changed": {
      const effectLogPath = requireArg(rest[0], "usage: pi-harness what-changed <effects.jsonl>");
      console.log(await whatChanged(effectLogPath));
      return;
    }
    case "inspect": {
      const policyLogPath = requireArg(rest[0], "usage: pi-harness inspect <policy.jsonl>");
      console.log(await inspectPolicy(policyLogPath));
      return;
    }
    case "replay": {
      const tapePath = requireArg(rest[0], "usage: pi-harness replay <tape.jsonl>");
      process.exit(await replayTape(tapePath));
    }
    default:
      console.error("usage: pi-harness <doctor|run|verify|what-changed|inspect|replay|hermes-demo|hermes-smoke|hermes-run|hermes-bridge|hermes-doctor> [args]");
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
