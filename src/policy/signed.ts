import { readFile } from "node:fs/promises";
import { PolicyDoc, PolicyDocSchema } from "./engine.js";
import { framedCanonical, hmacSha256Hex, sha256Hex } from "../schemas/canonical.js";
import { PiHarnessError } from "../errors.js";

export interface LoadedPolicy {
  doc: PolicyDoc;
  digest: string;         // sha256(framed canonical)
  signed: boolean;
}

/**
 * Load and (optionally) verify an HMAC-signed policy file.
 * - <path>        JSON policy document
 * - <path>.sig    "sha256-hmac:<hex>" over framedCanonical("pi-policy-v1", doc)
 *
 * In worker mode, missing/invalid signatures throw. In interactive modes,
 * signature failure logs a warning and returns `signed: false`.
 */
export async function loadPolicy(path: string, opts: { key?: Buffer; strict: boolean }): Promise<LoadedPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = PolicyDocSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new PiHarnessError("E_SCHEMA_PARSE", "policy schema invalid", { issues: parsed.error.issues });
  const doc = parsed.data;
  const framed = framedCanonical("pi-policy-v1", doc);
  const digest = "sha256:" + sha256Hex(framed);

  let sigText: string | null = null;
  try { sigText = await readFile(path + ".sig", "utf8"); } catch { /* no sig */ }

  if (!opts.key || !sigText) {
    if (opts.strict) throw new PiHarnessError("E_POLICY_SIG", "policy unsigned in strict mode");
    return { doc, digest, signed: false };
  }

  const m = sigText.trim().match(/^sha256-hmac:([0-9a-f]{64})$/);
  if (!m) {
    if (opts.strict) throw new PiHarnessError("E_POLICY_SIG", "malformed signature file");
    return { doc, digest, signed: false };
  }
  const expected = hmacSha256Hex(opts.key, framed);
  if (expected !== m[1]) {
    if (opts.strict) throw new PiHarnessError("E_POLICY_SIG", "signature mismatch");
    return { doc, digest, signed: false };
  }
  return { doc, digest, signed: true };
}

export function signPolicy(doc: PolicyDoc, key: Buffer): string {
  const framed = framedCanonical("pi-policy-v1", doc);
  return "sha256-hmac:" + hmacSha256Hex(key, framed);
}
