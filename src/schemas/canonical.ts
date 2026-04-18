import { createHash, createHmac } from "node:crypto";

/**
 * Canonicalize a JSON value per docs/SCHEMAS.md.
 * Sorted keys, no whitespace, no undefined/NaN/Infinity.
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalize: non-finite number");
    return Number.isInteger(v) ? v.toString() : v.toString();
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stringify).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stringify(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalize: unsupported type ${typeof v}`);
}

export type FrameTag = "pi-policy-v1" | "pi-tape-v1" | "pi-pimd-v1";

export function framedCanonical(frame: FrameTag, value: unknown): Buffer {
  return Buffer.from(frame + "\n" + canonicalize(value), "utf8");
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Hot path: hash (frame + "\n" + canonical(value)) without materializing the
 * combined Buffer. Streams three utf8 chunks into one sha256 instance — saves
 * one allocation and one copy per record, which matters in the tape writer's
 * tight loop (ADR 0002, p99 budget ≤ 2ms).
 */
export function sha256HexFramed(frame: FrameTag, value: unknown): string {
  return createHash("sha256")
    .update(frame, "utf8")
    .update("\n", "utf8")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

export function hmacSha256Hex(key: Buffer, buf: Buffer | string): string {
  return createHmac("sha256", key).update(buf).digest("hex");
}
