import { readFile } from "node:fs/promises";
import { PolicyDecisionSchema } from "../schemas/index.js";

export async function inspectPolicy(policyLog: string): Promise<string> {
  const raw = await readFile(policyLog, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const out: string[] = [];
  for (const l of lines) {
    const d = PolicyDecisionSchema.parse(JSON.parse(l));
    out.push(`${d.at} ${d.toolCallId} ${d.result} provenance=${d.provenanceMode}`);
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  inspectPolicy(process.argv[2]).then((s) => console.log(s));
}
