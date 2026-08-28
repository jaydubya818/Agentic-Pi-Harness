#!/usr/bin/env node
/**
 * compare-decisions.mjs [--semantic] <a.jsonl> <b.jsonl>
 *
 * Level C replay-drift check.
 *
 * Without --semantic (default): exact match on {result, winningRuleId,
 * provenanceMode} — matches v0.1 behavior.
 *
 * With --semantic: intended to be rule-id-agnostic, comparing {result,
 * toolName, effectClass} so that a rule rename which preserves behaviour is
 * not reported as drift.
 *
 * What it actually compares today is {result} and nothing else. A
 * `PolicyDecision` (src/schemas/policyDecision.ts) has no `toolName` and no
 * `input` field, and `appendPolicyDecision` writes the log through
 * `PolicyDecisionSchema.safeParse`, which strips any such key a caller adds.
 * So `rec.toolName` is `undefined` on every line of every policy log this
 * repo produces, the `tool` fallback below is the only branch that ever runs,
 * and `classify("", {})` always returns "other". Every record therefore
 * hashes {result, "", "other"}.
 *
 * The consequence is that --semantic is strictly weaker than the default
 * mode, not orthogonal to it: {result} is a subset of {result,
 * winningRuleId, provenanceMode}, so the semantic pass can never fail a
 * comparison the exact pass accepted. Two logs whose calls were approved by
 * entirely different rules come back "decisions match". Making the check
 * mean what it says requires the decision record to carry the tool identity
 * it was made about — a schema change, and therefore a golden re-baseline.
 * See docs/NIGHTLY-BACKLOG.md (2026-08-28). `src/policy/semanticHash.ts`
 * already implements the intended comparison against a real toolName/input
 * pair; it has no caller.
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
    // Decision records in the policy log carry a toolCallId, never a
    // toolName or an input. Both fallbacks below therefore fire on every
    // record, which is what reduces this signature to {result}; see the
    // header comment.
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
