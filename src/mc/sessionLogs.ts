import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { McSessionLogRef } from "./client.js";

export type McSessionLogKind = McSessionLogRef["kind"];

export interface SessionLogPathInput {
  kind: McSessionLogKind;
  path: string;
}

const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{8,})|(ghp_[A-Za-z0-9]{16,})|(xox[baprs]-[A-Za-z0-9-]{10,})|(AKIA[0-9A-Z]{16})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

/**
 * Redact known secret shapes then tail-truncate to maxBytes (UTF-8 aware).
 * Tail-truncation keeps the most recent log lines, which is where terminal
 * status lives.
 */
export function redactedExcerpt(text: string, maxBytes: number): string {
  const redacted = text.replace(SECRET_PATTERN, "[REDACTED]");
  const buffer = Buffer.from(redacted, "utf8");
  if (buffer.byteLength <= maxBytes) return redacted;
  // Slice the tail, then drop any leading partial multi-byte character.
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8").replace(/^�+/, "");
}

/**
 * Build session log references (path + sha256 + size + redacted excerpt) for
 * runs:complete. NEVER uploads full logs — refs and a bounded excerpt only.
 * Missing files are skipped silently.
 */
export async function buildSessionLogRefs(
  paths: SessionLogPathInput[],
  options: { excerptMaxBytes?: number } = {},
): Promise<McSessionLogRef[]> {
  const excerptMaxBytes = options.excerptMaxBytes ?? 4096;
  const refs: McSessionLogRef[] = [];
  for (const input of paths) {
    const filePath = resolve(input.path);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    const content = await readFile(filePath);
    refs.push({
      kind: input.kind,
      path: filePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: fileStat.size,
      excerpt: redactedExcerpt(content.toString("utf8"), excerptMaxBytes),
    });
  }
  return refs;
}
