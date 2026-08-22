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

/**
 * Total, build-independent string ordering for anything that lands in an
 * artifact (effect-record path lists, artifact scans, any sorted evidence).
 *
 * `String.prototype.localeCompare` is the wrong tool here twice over:
 *
 *   1. ICU collation is not antisymmetric over distinct strings. Characters
 *      such as U+00AD SOFT HYPHEN and U+200B ZERO WIDTH SPACE are ignorable at
 *      primary strength, so two *different* paths compare equal. Because
 *      `Array.prototype.sort` is stable, those elements then keep their input
 *      order -- reintroducing exactly the `readdir` ordering nondeterminism
 *      the sort exists to remove.
 *   2. Its result depends on the ICU data the Node binary was built against
 *      (full-icu vs small-icu vs system-icu, and the ICU version), so two
 *      hosts can order the same file set differently. That matters especially
 *      on Pi-class hosts, which commonly run system-icu builds.
 *
 * Comparing UTF-16 code units -- the same total order `Array#sort` uses with
 * no comparator -- is deterministic on every build and for every input.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
