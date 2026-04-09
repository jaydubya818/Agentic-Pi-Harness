#!/usr/bin/env node
/**
 * Schema-drift guard.
 *
 * Rule: every change to a file under src/schemas/ must be accompanied by a
 * corresponding change to docs/SCHEMAS.md in the same commit. If schema
 * files changed but the docs file did not, abort the commit.
 *
 * This is a blunt but effective guardrail — it forces the schema version
 * policy (bump schemaVersion, write a migration note) to happen at the
 * same time as the code change, not "later".
 */
import { execSync } from "node:child_process";

function staged() {
  const out = execSync("git diff --cached --name-only", { encoding: "utf8" });
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

const files = staged();
const schemaTouched = [...files].some((file) => file.startsWith("src/schemas/") && file.endsWith(".ts"));
const docsTouched = files.has("docs/SCHEMAS.md");

if (schemaTouched && !docsTouched) {
  console.error("✖ schema-drift: files under src/schemas/ changed but docs/SCHEMAS.md did not.");
  console.error("  Bump schemaVersion and record the migration in docs/SCHEMAS.md, then re-stage.");
  process.exit(1);
}
process.exit(0);
