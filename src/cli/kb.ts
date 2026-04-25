#!/usr/bin/env node
import { printHermesAcceptanceResult, runHermesAcceptanceCli } from "./acceptance-hermes.js";
import { printPiAcceptanceResult, runPiAcceptanceCli } from "./acceptance-pi.js";

export function kbUsage(): string {
  return "usage: kb session acceptance <hermes|pi> [args]";
}

export async function runKbCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [scope, action, target, ...rest] = argv;

  if (scope === "session" && action === "acceptance" && target === "hermes") {
    const result = await runHermesAcceptanceCli(rest);
    printHermesAcceptanceResult(result);
    return result.ok ? 0 : 1;
  }

  if (scope === "session" && action === "acceptance" && target === "pi") {
    const result = await runPiAcceptanceCli(rest);
    printPiAcceptanceResult(result);
    return result.ok ? 0 : 1;
  }

  console.error(kbUsage());
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKbCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
