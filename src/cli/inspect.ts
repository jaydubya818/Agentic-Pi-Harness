import { isCliEntrypoint } from "./args.js";
import { readPolicyLog, renderPolicyInspection } from "../policy/decision.js";

export async function inspectPolicy(policyLog: string): Promise<string> {
  const decisions = await readPolicyLog(policyLog);
  return renderPolicyInspection(decisions);
}

if (isCliEntrypoint(import.meta.url)) {
  const policyLogPath = process.argv[2];
  if (!policyLogPath) {
    console.error("usage: inspect <policy.jsonl>");
    process.exit(2);
  }
  inspectPolicy(policyLogPath).then(
    (s) => console.log(s),
    (error) => {
      // Match the replay/verify/what-changed CLI contract: clean FAIL line
      // + exit 1 instead of an unhandled-rejection stack trace.
      console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
