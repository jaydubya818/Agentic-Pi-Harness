#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { verifyTape } from "./verify.js";
import { whatChanged } from "./what-changed.js";
import { inspectPolicy } from "./inspect.js";
import { runGoldenPath } from "./run.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "doctor": {
      const cs = await doctor();
      for (const c of cs) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? " (" + c.detail + ")" : ""}`);
      process.exit(cs.every((c) => c.ok) ? 0 : 1);
    }
    case "verify": {
      const r = await verifyTape(rest[0]);
      if (r.ok) { console.log(`ok ${r.records} records digest=${r.digest}`); return; }
      console.error(`FAIL: ${r.error}`); process.exit(1);
    }
    case "what-changed": console.log(await whatChanged(rest[0])); return;
    case "inspect": console.log(await inspectPolicy(rest[0])); return;
    case "run": {
      const id = await runGoldenPath(rest[0] ?? "./.pi-work", rest[1] ?? "./.pi-out");
      console.log("session " + id); return;
    }
    default:
      console.error("usage: pi-harness <doctor|verify|what-changed|inspect|run> [args]");
      process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
