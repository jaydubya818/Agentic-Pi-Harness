import { posix } from "node:path";
import { PiHarnessError } from "../errors.js";
import { PolicyDecision } from "../schemas/index.js";
import { ToolClass } from "../tools/concurrency.js";

export interface WorkerModeControls {
  signedPolicy: boolean;
  requireSignedPolicy?: boolean;
  allowedWritePathPrefixes?: string[];
  maxWritePaths?: number;
  allowExclusiveTools?: boolean;
  /**
   * Reserved: no subagent spawn path exists in the loop yet, so
   * `validateWorkerModeInputs` refuses a worker session that sets either
   * field rather than accept a control nothing enforces.
   */
  allowSubagents?: boolean;
  maxSubagents?: number;
}

export interface WorkerToolDecision {
  allowed: boolean;
  reason?: string;
  manifestInfluence: PolicyDecision["manifestInfluence"];
}

function normalizeForPrefixCheck(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/"));
}

/**
 * Boundary-aware prefix containment. Plain `startsWith` allowed two bypasses:
 * sibling directories ("sandbox-evil/x" matched prefix "sandbox"), and
 * traversal ("sandbox/../secret" matched prefix "sandbox/").
 */
function isWithinPrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizeForPrefixCheck(path);
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) return false;
  const normalizedPrefix = normalizeForPrefixCheck(prefix).replace(/\/+$/, "");
  if (normalizedPrefix === "" || normalizedPrefix === ".") return true;
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + "/");
}

/**
 * Collect every path a write targets. `path` and `paths` are unioned rather
 * than checked in precedence order: a call carrying both had only `path`
 * inspected, so `{ path: "sandbox/ok", paths: ["/etc/shadow"] }` slipped past
 * both allowedWritePathPrefixes and maxWritePaths.
 */
function extractPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const collected: string[] = [];
  if (typeof record.path === "string") collected.push(record.path);
  if (Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === "string") collected.push(path);
    }
  }
  return [...new Set(collected)];
}

export function validateWorkerModeInputs(input: {
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  workerControls?: WorkerModeControls;
  approvalRequesterConfigured: boolean;
}): void {
  if (input.mode !== "worker" || !input.workerControls) return;
  if ((input.workerControls.requireSignedPolicy ?? true) && !input.workerControls.signedPolicy) {
    throw new PiHarnessError("E_POLICY_SIG", "worker mode requires a signed policy", {}, { retryable: false });
  }
  if (input.approvalRequesterConfigured) {
    throw new PiHarnessError("E_TOOL_FORBIDDEN", "worker mode disallows interactive approval requesters", {}, { retryable: false });
  }
  // Nothing in the loop spawns subagents, so there is no site at which
  // these two controls could be enforced. Accepting them would let an
  // operator believe a cap is in force that nothing reads; refuse the
  // session instead, so wiring subagent spawning has to wire these too.
  if (input.workerControls.allowSubagents !== undefined || input.workerControls.maxSubagents !== undefined) {
    throw new PiHarnessError(
      "E_TOOL_FORBIDDEN",
      "worker mode cannot honour allowSubagents/maxSubagents: the loop has no subagent spawn path, so the control would be accepted but never enforced; unset it",
      { allowSubagents: input.workerControls.allowSubagents, maxSubagents: input.workerControls.maxSubagents },
      { retryable: false },
    );
  }
}

export function evaluateWorkerToolUse(input: {
  mode: "plan" | "assist" | "autonomous" | "worker" | "dry-run";
  workerControls?: WorkerModeControls;
  toolName: string;
  toolClass: ToolClass;
  toolInput: unknown;
}): WorkerToolDecision {
  if (input.mode !== "worker" || !input.workerControls) {
    return { allowed: true, manifestInfluence: null };
  }

  if (input.toolClass === "exclusive" && !input.workerControls.allowExclusiveTools) {
    return {
      allowed: false,
      reason: `worker control denied exclusive tool ${input.toolName}`,
      manifestInfluence: { field: "workerControl", value: "exclusiveDenied" },
    };
  }

  if (input.toolName === "write_file") {
    const paths = extractPaths(input.toolInput);
    if (typeof input.workerControls.maxWritePaths === "number" && paths.length > input.workerControls.maxWritePaths) {
      return {
        allowed: false,
        reason: `worker control denied write_file with ${paths.length} paths`,
        manifestInfluence: { field: "workerControl", value: "maxWritePaths" },
      };
    }

    if (input.workerControls.allowedWritePathPrefixes?.length) {
      // Fail closed: a write whose input yields no extractable paths would
      // otherwise pass vacuously (`[].every(...)` is true) and bypass the
      // prefix restriction entirely.
      const allowed = paths.length > 0
        && paths.every((path) => input.workerControls!.allowedWritePathPrefixes!.some((prefix) => isWithinPrefix(path, prefix)));
      if (!allowed) {
        return {
          allowed: false,
          reason: `worker control denied write path outside allowed prefixes`,
          manifestInfluence: { field: "workerControl", value: "writePathPrefix" },
        };
      }
    }
  }

  return { allowed: true, manifestInfluence: null };
}
