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

const key = (recs) => recs.map((r) => JSON.stringify(r.postHashes)).join("|");

if (a.length !== b.length) {
  console.error(`replay drift: record count ${a.length} vs ${b.length}`);
  process.exit(1);
}
if (key(a) !== key(b)) {
  console.error("replay drift: postHashes diverge");
  process.exit(1);
}
console.log(`replay deterministic: ${a.length} effect records match`);
