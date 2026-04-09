import { describe, expect, it } from "vitest";
import { evaluateWorkerToolUse, validateWorkerModeInputs } from "../../src/runtime/workerControls.js";
import { ConcurrencyClassifier } from "../../src/tools/concurrency.js";

describe("worker controls", () => {
  it("requires a signed policy and disallows interactive approvals in worker mode", () => {
    expect(() => validateWorkerModeInputs({
      mode: "worker",
      workerControls: { signedPolicy: false, requireSignedPolicy: true },
      approvalRequesterConfigured: false,
    })).toThrow(/signed policy/);

    expect(() => validateWorkerModeInputs({
      mode: "worker",
      workerControls: { signedPolicy: true },
      approvalRequesterConfigured: true,
    })).toThrow(/approval/);

    expect(() => validateWorkerModeInputs({
      mode: "assist",
      workerControls: { signedPolicy: false },
      approvalRequesterConfigured: true,
    })).not.toThrow();
  });

  it("enforces worker blast-radius controls for writes and exclusive tools", () => {
    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox/"], maxWritePaths: 1 },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "sandbox/a.txt" },
    })).toEqual({ allowed: true, manifestInfluence: null });

    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox/"], maxWritePaths: 1 },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "src/a.txt" },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "writePathPrefix" } });

    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowExclusiveTools: false },
      toolName: "bash",
      toolClass: "exclusive",
      toolInput: { command: "echo hi" },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "exclusiveDenied" } });
  });
});
