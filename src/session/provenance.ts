import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOrThrow, ProvenanceManifest, ProvenanceManifestSchema } from "../schemas/index.js";
import { canonicalize, sha256Hex } from "../schemas/canonical.js";
import { PiHarnessError } from "../errors.js";

export interface CreateProvenanceManifestInput {
  sessionId: string;
  loopGitSha: string;
  repoGitSha: string | null;
  provider: string;
  model: string;
  costTableVersion: string;
  piMdDigest: string | null;
  policyDigest: string;
  createdAt?: string;
}

/** Write-rename + fsync for crash-safety. */
export async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  const json = JSON.stringify(value, null, 2) + "\n";

  await writeFile(tmp, json, "utf8");

  const fileHandle = await open(tmp, "r");
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tmp, path);

  const dirHandle = await open(dirname(path), "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

export function createProvenanceManifest(input: CreateProvenanceManifestInput): ProvenanceManifest {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    loopGitSha: input.loopGitSha,
    repoGitSha: input.repoGitSha,
    provider: input.provider,
    model: input.model,
    costTableVersion: input.costTableVersion,
    piMdDigest: input.piMdDigest,
    policyDigest: input.policyDigest,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function writeProvenance(path: string, manifest: ProvenanceManifest): Promise<ProvenanceManifest> {
  const parsed = ProvenanceManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "provenance invalid", { issues: parsed.error.issues });
  }

  await safeWriteJson(path, parsed.data);
  return parsed.data;
}

export async function readProvenance(path: string): Promise<ProvenanceManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "failed to read provenance", {
      path,
      cause: String(error),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "failed to parse provenance json", {
      path,
      cause: String(error),
    });
  }

  try {
    return parseOrThrow(ProvenanceManifestSchema, parsedJson, "provenance");
  } catch (error) {
    throw new PiHarnessError("E_SCHEMA_PARSE", "provenance schema invalid", {
      path,
      cause: String(error),
    });
  }
}

export async function writeSessionStartProvenance(path: string, input: CreateProvenanceManifestInput): Promise<ProvenanceManifest> {
  const manifest = createProvenanceManifest(input);
  return writeProvenance(path, manifest);
}

export function digestPolicy(policy: unknown): string {
  return "sha256:" + sha256Hex("pi-policy-v1\n" + canonicalize(policy));
}
