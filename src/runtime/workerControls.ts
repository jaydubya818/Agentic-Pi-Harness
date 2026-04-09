import { PiHarnessError } from "../errors.js";
import { PolicyDecision } from "../schemas/index.js";
import { ToolClass } from "../tools/concurrency.js";

export interface WorkerModeControls {
  signedPolicy: boolean;
  requireSignedPolicy?: boolean;
  allowedWritePathPrefixes?: string[];
  maxWritePaths?: number;
  allowExclusiveTools?: boolean;
  allowSubagents?: boolean;
  maxSubagents?: number;
}

export interface WorkerToolDecision {
  allowed: boolean;
  reason?: string;
  manifestInfluence: PolicyDecision["manifestInfluence"];
}

function extractPaths(input: unknown): string[] {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string") return [record.path];
    if (Array.isArray(record.paths)) return record.paths.filter((path): path is string => typeof path === "string");
  }
  return [];
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
      const allowed = paths.every((path) => input.workerControls!.allowedWritePathPrefixes!.some((prefix) => path.startsWith(prefix)));
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
