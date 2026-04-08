import { writeFile, rename, open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ProvenanceManifest, ProvenanceManifestSchema } from "../schemas/index.js";
import { canonicalize, sha256Hex } from "../schemas/canonical.js";
import { PiHarnessError } from "../errors.js";

/** Write-rename + fsync for crash-safety. */
export async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2));
  const fh = await open(tmp, "r+");
  try { await fh.sync(); } finally { await fh.close(); }
  await rename(tmp, path);
}

export async function writeProvenance(path: string, m: ProvenanceManifest): Promise<void> {
  const parsed = ProvenanceManifestSchema.safeParse(m);
  if (!parsed.success) throw new PiHarnessError("E_SCHEMA_PARSE", "provenance invalid", { issues: parsed.error.issues });
  await safeWriteJson(path, m);
}

export function digestPolicy(policy: unknown): string {
  return "sha256:" + sha256Hex("pi-policy-v1\n" + canonicalize(policy));
}
