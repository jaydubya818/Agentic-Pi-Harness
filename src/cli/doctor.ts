import { isCliEntrypoint } from "./args.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTape } from "../replay/recorder.js";

// Anchor every check at the package root (two levels above this module:
// src/cli/ in dev, dist/cli/ compiled) instead of process.cwd(), so
// `pi-harness doctor` reports on the harness itself from any directory
// rather than failing 3 of 4 checks outside the repo root.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Check { name: string; ok: boolean; detail?: string; }

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node >= 20", ok: major >= 20, detail: process.versions.node });

  try {
    const tv = await readFile(join(packageRoot, ".tool-versions"), "utf8");
    checks.push({ name: ".tool-versions present", ok: /nodejs/.test(tv) });
  } catch {
    checks.push({ name: ".tool-versions present", ok: false });
  }

  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    checks.push({ name: "zod installed", ok: !!pkg.dependencies?.zod });
  } catch {
    checks.push({ name: "package.json", ok: false });
  }

  const goldenTape = await verifyTape(join(packageRoot, "goldens", "canonical", "tape.jsonl"));
  checks.push({
    name: "canonical golden tape verifies",
    ok: goldenTape.ok,
    detail: goldenTape.ok ? goldenTape.digest : goldenTape.error,
  });

  return checks;
}

if (isCliEntrypoint(import.meta.url)) {
  doctor().then((cs) => {
    for (const c of cs) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? " (" + c.detail + ")" : ""}`);
    process.exit(cs.every((c) => c.ok) ? 0 : 1);
  });
}
