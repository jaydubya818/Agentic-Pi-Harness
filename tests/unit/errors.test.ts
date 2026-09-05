import { describe, expect, it } from "vitest";

import { PiHarnessError, type PiErrorCode } from "../../src/errors.js";

// PiHarnessError/ERROR_DEFAULTS had no direct test — every existing reference
// is incidental (other suites catch a PiHarnessError thrown by the code under
// test). docs/NIGHTLY-BACKLOG.md (2026-08-28) records that `.retryable` is
// set here per-code but read nowhere: classifyRetryableModelError branches on
// code prefix/allowlist instead, so an E_MODEL_ADAPTER's own `retryable: true`
// default is never actually consulted for a retry decision. Not fixed here —
// that is the reconciliation decision the backlog entry asks for — but this
// pins the table itself and the constructor's override behavior so a future
// change to either has to touch a test.
const ALL_CODES: PiErrorCode[] = [
  "E_SCHEMA_PARSE", "E_SCHEMA_VERSION", "E_SCHEMA_MISMATCH", "E_POLICY_SIG",
  "E_HOOK_TIMEOUT", "E_HOOK_EXIT", "E_HOOK_SHELL", "E_TAPE_HASH",
  "E_TAPE_MIGRATE", "E_CHECKPOINT_WRITE", "E_EFFECT_PRE_HASH", "E_EFFECT_CAPTURE",
  "E_WORKTREE_ESCAPE", "E_BUDGET_EXCEEDED", "E_TOOL_FORBIDDEN", "E_PROMPT_ASSEMBLY",
  "E_MODEL_ADAPTER", "E_OTEL_UNAVAILABLE", "E_LOG_UNAVAILABLE", "E_POLICY_CYCLE",
  "E_UNKNOWN",
];

describe("PiHarnessError", () => {
  it("is a real Error with a stable name and the given message", () => {
    const err = new PiHarnessError("E_UNKNOWN", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PiHarnessError");
    expect(err.message).toBe("boom");
  });

  it("defaults context to {} when omitted", () => {
    expect(new PiHarnessError("E_UNKNOWN", "x").context).toEqual({});
  });

  it("carries the context object it is given", () => {
    const ctx = { sessionId: "s1", attempt: 2 };
    expect(new PiHarnessError("E_UNKNOWN", "x", ctx).context).toBe(ctx);
  });

  it("every declared error code produces a well-formed severity/retryable default", () => {
    for (const code of ALL_CODES) {
      const err = new PiHarnessError(code, "x");
      expect(["warn", "error", "fatal"]).toContain(err.severity);
      expect(typeof err.retryable).toBe("boolean");
      expect(err.code).toBe(code);
    }
  });

  it("the only two codes defaulting retryable:true are E_HOOK_TIMEOUT and E_MODEL_ADAPTER", () => {
    const retryableByDefault = ALL_CODES.filter((c) => new PiHarnessError(c, "x").retryable);
    expect(retryableByDefault.sort()).toEqual(["E_HOOK_TIMEOUT", "E_MODEL_ADAPTER"]);
  });

  it("the only three codes defaulting to fatal severity are POLICY_SIG, CHECKPOINT_WRITE, WORKTREE_ESCAPE", () => {
    const fatalByDefault = ALL_CODES.filter((c) => new PiHarnessError(c, "x").severity === "fatal");
    expect(fatalByDefault.sort()).toEqual(["E_CHECKPOINT_WRITE", "E_POLICY_SIG", "E_WORKTREE_ESCAPE"]);
  });

  it("explicit options override the per-code default in both directions", () => {
    // E_SCHEMA_PARSE defaults to {severity: "error", retryable: false} —
    // both overridden here to their opposite.
    const overridden = new PiHarnessError("E_SCHEMA_PARSE", "x", {}, { severity: "warn", retryable: true });
    expect(overridden.severity).toBe("warn");
    expect(overridden.retryable).toBe(true);

    // E_HOOK_TIMEOUT defaults retryable:true — explicitly forcing it false
    // is respected, not just falling back to the default.
    const forced = new PiHarnessError("E_HOOK_TIMEOUT", "x", {}, { retryable: false });
    expect(forced.retryable).toBe(false);
  });

  it("options.severity/retryable set to their own default value still work (not mistaken for omitted)", () => {
    // `options.retryable ?? DEFAULT` only breaks if a caller explicitly
    // passes the same false the default already is and it gets treated as
    // "not provided" — it should not, since ?? only falls through on
    // null/undefined, not on false.
    const err = new PiHarnessError("E_HOOK_TIMEOUT", "x", {}, { retryable: false, severity: "error" });
    expect(err.retryable).toBe(false);
  });
});
