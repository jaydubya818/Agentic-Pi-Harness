#!/usr/bin/env node
/**
 * compare-decisions.mjs [--semantic] <a.jsonl> <b.jsonl>
 *
 * Level C replay-drift check.
 *
 * Without --semantic (default): exact match on {result, winningRuleId,
 * provenanceMode} — matches v0.1 behavior.
 *
 * With --semantic: rule-id-agnostic. Compares only {result, toolName,
 * effectClass}. A rule rename that preserves behavior is NOT drift.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const semantic = args.includes("--semantic");
const positional = args.filter((a) => !a.startsWith("--"));
const [aPath, bPath] = positional;

if (!aPath || !bPath) {
  console.error("usage: compare-decisions.mjs [--semantic] <a.jsonl> <b.jsonl>");
  process.exit(2);
}

function classify(toolName, input) {
  const n = (toolName || "").toLowerCase();
  if (n.startsWith("read") || n === "ls" || n === "stat") return "read-path";
  if (n.startsWith("write") || n === "mv" || n === "rm" || n === "mkdir") return "write-path";
  if (n === "bash" || n === "exec" || n === "sh") return "exec";
  if (n.startsWith("http") || n === "fetch" || n === "curl") return "net";
  if (input && typeof input === "object") {
    if (typeof input.url === "string") return "net";
    if (typeof input.cmd === "string") return "exec";
    if (typeof input.path === "string" || Array.isArray(input.paths)) {
      return "content" in input || "data" in input ? "write-path" : "read-path";
    }
  }
  return "other";
}

const parse = (p) =>
  readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const a = parse(aPath);
const b = parse(bPath);

if (a.length !== b.length) {
  console.error(`drift: record count ${a.length} vs ${b.length}`);
  process.exit(1);
}

function sig(rec) {
  if (semantic) {
    // Decision records in the policy log don't carry toolName / input
    // directly — they carry toolCallId. If the upstream writer didn't
    // embed toolName, fall back to comparing just {result}.
    const tool = rec.toolName ?? "";
    const cls = classify(tool, rec.input ?? {});
    return createHash("sha256").update(JSON.stringify({ r: rec.result, t: tool, c: cls })).digest("hex");
  }
  return JSON.stringify({ r: rec.result, w: rec.winningRuleId, p: rec.provenanceMode });
}

const drifted = [];
for (let i = 0; i < a.length; i++) {
  if (sig(a[i]) !== sig(b[i])) drifted.push(a[i].toolCallId ?? i);
}
if (drifted.length) {
  console.error(`drift: ${drifted.length} decision(s) diverge: ${drifted.slice(0, 5).join(", ")}${drifted.length > 5 ? "..." : ""}`);
  process.exit(1);
}
console.log(`decisions match: ${a.length} records ${semantic ? "(semantic)" : "(exact)"}`);
