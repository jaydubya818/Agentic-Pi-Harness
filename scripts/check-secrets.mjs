#!/usr/bin/env node
/**
 * Staged-secret guard (RISK-REGISTER R11).
 *
 * R11 records that signing keys and bridge tokens are handled by convention
 * only — "no programmatic check exists". This is that check: a pre-commit
 * guard that refuses to stage key material or a literal credential.
 *
 * Two independent passes, both deliberately narrow so the hook stays a
 * guardrail rather than a nuisance:
 *
 *   1. Path pass  — filenames that are key/credential material by definition
 *                   (`*.pem`, `*.key`, `id_rsa`, a real `.env`).
 *   2. Content pass — a small set of unambiguous, self-identifying secret
 *                   prefixes. Nothing heuristic like "long base64 string":
 *                   this repo commits hashes, digests, and HMAC signatures
 *                   all day and they must not trip the hook.
 *
 * Escape hatch: `git commit --no-verify` (and note why in the commit body).
 */
import { execFileSync } from "node:child_process";

/** Filenames that are credential material regardless of their contents. */
const SECRET_PATH_PATTERNS = [
  { pattern: /\.(?:pem|key|p12|pfx|jks|keystore)$/i, why: "private key / keystore file" },
  { pattern: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, why: "ssh private key" },
  { pattern: /(?:^|\/)\.npmrc$/, why: "npm credentials file" },
  { pattern: /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/, why: "environment file with real values" },
];

/**
 * Paths that look like the above but are safe by construction: templates and
 * fixtures whose whole purpose is to show the shape without the value.
 */
const SECRET_PATH_ALLOWLIST = [
  /(?:^|\/)\.env\.(?:example|sample|template)$/,
  /(?:^|\/)\.env\.d\.ts$/,
];

/**
 * Self-identifying credential prefixes. Every entry must be a token format
 * that cannot plausibly be anything else — no entropy heuristics.
 */
const SECRET_CONTENT_PATTERNS = [
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, why: "inline private key" },
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/, why: "github personal access token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, why: "github fine-grained pat" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, why: "slack token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: "aws access key id" },
  { pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/, why: "model provider api key" },
  // The harness's own bearer token, assigned a literal rather than read from
  // the environment (see hermes-bridge --auth-token / PI_HERMES_BRIDGE_TOKEN).
  { pattern: /PI_HERMES_BRIDGE_TOKEN\s*[=:]\s*["'][^"'$][^"']*["']/, why: "hardcoded bridge auth token" },
];

export function classifyStagedPath(path) {
  if (SECRET_PATH_ALLOWLIST.some((allowed) => allowed.test(path))) return null;
  const hit = SECRET_PATH_PATTERNS.find((entry) => entry.pattern.test(path));
  return hit ? hit.why : null;
}

/**
 * The guard's own source and its test suite contain every pattern above by
 * construction. Without this exemption the content pass refused any commit
 * that touched them, so the hook could never be edited or extended with
 * itself installed — and the escape hatch (`--no-verify`) disables the guard
 * for the whole commit, including the files that actually needed checking.
 * The path pass still applies: this only skips the content scan.
 */
const GUARD_OWN_FIXTURES = [
  /(?:^|\/)scripts\/check-secrets\.mjs$/,
  /(?:^|\/)tests\/unit\/checkSecrets\.test\.ts$/,
];

export function isGuardOwnFixture(path) {
  return GUARD_OWN_FIXTURES.some((entry) => entry.test(path));
}

export function scanContentForSecrets(text) {
  return SECRET_CONTENT_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.why);
}

function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function stagedContent(path) {
  try {
    // Read the staged blob, not the worktree file: the hook must judge what
    // is actually about to be committed.
    return execFileSync("git", ["show", `:${path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    // Binary blob, deleted path, or an oversized file — the path pass above
    // is the only signal available for those.
    return null;
  }
}

function main() {
  const findings = [];
  for (const path of stagedFiles()) {
    const pathWhy = classifyStagedPath(path);
    if (pathWhy) findings.push(`${path}: ${pathWhy}`);
    if (isGuardOwnFixture(path)) continue;
    const content = stagedContent(path);
    if (content === null) continue;
    for (const why of scanContentForSecrets(content)) findings.push(`${path}: ${why}`);
  }

  if (findings.length === 0) return 0;
  console.error("✖ staged-secret guard (RISK-REGISTER R11) refused this commit:");
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error("  Move the value behind an environment variable and re-stage.");
  console.error("  If this is a false positive, re-run with `git commit --no-verify` and say why in the message.");
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-secrets.mjs")) {
  process.exit(main());
}
