#!/usr/bin/env node
/**
 * compare-effects.mjs <a.jsonl> <b.jsonl>
 *
 * Replay-drift check: two independent runs of the golden path must produce
 * effect logs with the same set of post-hashes in the same order. Exits 1
 * if they diverge.
 */
import { readFileSync } from "node:fs";

const [, , aPath, bPath] = process.argv;
if (!aPath || !bPath) {
  console.error("usage: compare-effects.mjs <a.jsonl> <b.jsonl>");
  process.exit(2);
}

const parse = (p) =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const a = parse(aPath);
const b = parse(bPath);

/**
 * Determinism check: two independent runs in two different workdirs will
 * naturally key postHashes under different absolute paths, so we compare
 * the SORTED hash values per record (path-agnostic) plus the tool name +
 * binaryChanged + rollbackConfidence flags.
 */
const sig = (recs) =>
  recs.map((r) => JSON.stringify({
    t: r.toolName,
    h: Object.values(r.postHashes).sort(),
    p: Object.values(r.preHashes).sort(),
    b: r.binaryChanged,
    rc: r.rollbackConfidence,
  })).join("|");

if (a.length !== b.length) {
  console.error(`replay drift: record count ${a.length} vs ${b.length}`);
  process.exit(1);
}
if (sig(a) !== sig(b)) {
  console.error("replay drift: effect signatures diverge");
  console.error("a:", sig(a));
  console.error("b:", sig(b));
  process.exit(1);
}
console.log(`replay deterministic: ${a.length} effect records match (path-agnostic)`);
