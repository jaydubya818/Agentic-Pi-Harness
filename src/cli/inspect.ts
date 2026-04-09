import { readPolicyLog, renderPolicyInspection } from "../policy/decision.js";

export async function inspectPolicy(policyLog: string): Promise<string> {
  const decisions = await readPolicyLog(policyLog);
  return renderPolicyInspection(decisions);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const policyLogPath = process.argv[2];
  if (!policyLogPath) {
    console.error("usage: inspect <policy.jsonl>");
    process.exit(2);
  }
  inspectPolicy(policyLogPath).then((s) => console.log(s));
}
