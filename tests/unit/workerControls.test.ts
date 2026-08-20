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

  it("denies prefix-bypass writes via traversal and sibling directories", () => {
    const controls = { signedPolicy: true, allowedWritePathPrefixes: ["sandbox/"] };
    const evaluate = (path: string) => evaluateWorkerToolUse({
      mode: "worker",
      workerControls: controls,
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path },
    });

    // traversal escaping the allowed prefix
    expect(evaluate("sandbox/../src/a.txt")).toMatchObject({ allowed: false });
    expect(evaluate("sandbox/../../etc/passwd")).toMatchObject({ allowed: false });
    // sibling directory sharing the string prefix (prefix without trailing slash)
    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox"] },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "sandbox-evil/a.txt" },
    })).toMatchObject({ allowed: false });
    // absolute path cannot satisfy a relative prefix
    expect(evaluate("/etc/passwd")).toMatchObject({ allowed: false });
    // traversal that stays inside the prefix is still allowed
    expect(evaluate("sandbox/sub/../a.txt")).toEqual({ allowed: true, manifestInfluence: null });
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
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox/"] },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { file: "sandbox/a.txt" },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "writePathPrefix" } });

    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowExclusiveTools: false },
      toolName: "bash",
      toolClass: "exclusive",
      toolInput: { command: "echo hi" },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "exclusiveDenied" } });
  });
  it("inspects both `path` and `paths` when a write carries both", () => {
    // `{ path, paths }` used to have only `path` read, so the extra targets
    // escaped both the prefix allowlist and the write-path cap.
    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox"] },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "sandbox/ok.txt", paths: ["/etc/shadow"] },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "writePathPrefix" } });

    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, maxWritePaths: 2 },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "sandbox/a.txt", paths: ["sandbox/b.txt", "sandbox/c.txt"] },
    })).toMatchObject({ allowed: false, manifestInfluence: { field: "workerControl", value: "maxWritePaths" } });

    // The union is de-duplicated, so repeating one path does not inflate the count.
    expect(evaluateWorkerToolUse({
      mode: "worker",
      workerControls: { signedPolicy: true, maxWritePaths: 1, allowedWritePathPrefixes: ["sandbox"] },
      toolName: "write_file",
      toolClass: "serial",
      toolInput: { path: "sandbox/a.txt", paths: ["sandbox/a.txt"] },
    })).toMatchObject({ allowed: true });
  });
});
