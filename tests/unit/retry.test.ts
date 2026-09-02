import { describe, expect, it } from "vitest";
import {
  classifyRetryableModelError,
  computeRetryDelayMs,
  normalizeRetryError,
  shouldRetryModelInvocation,
} from "../../src/retry/stateMachine.js";
import { PiHarnessError } from "../../src/errors.js";

function transientError(code: string): Error & { code: string } {
  const error = new Error(`transient ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

describe("retry helpers", () => {
  it("classifies allowlisted model-open transport failures as retryable", () => {
    expect(classifyRetryableModelError(transientError("ECONNRESET"), { hasPersistedEvent: false })).toBe("model_open_transient");
    expect(classifyRetryableModelError({ status: 503 }, { hasPersistedEvent: false })).toBe("model_open_transient");
    // 529 is the Anthropic overloaded_error; 408 is a server-side request timeout.
    expect(classifyRetryableModelError({ status: 529 }, { hasPersistedEvent: false })).toBe("model_open_transient");
    expect(classifyRetryableModelError({ status: 408 }, { hasPersistedEvent: false })).toBe("model_open_transient");
    expect(classifyRetryableModelError({ code: "UND_ERR_BODY_TIMEOUT" }, { hasPersistedEvent: false })).toBe("model_open_transient");
    // A 500 is not distinguishable from a deterministic rejection.
    expect(classifyRetryableModelError({ status: 500 }, { hasPersistedEvent: false })).toBe("model_open_fail_closed");
  });

  it("fails closed once the current invocation has already persisted an event", () => {
    expect(classifyRetryableModelError(transientError("ECONNRESET"), { hasPersistedEvent: true })).toBe("model_midstream_after_persist");
  });

  it("keeps schema and persistence failures non-retryable", () => {
    expect(classifyRetryableModelError(new PiHarnessError("E_SCHEMA_PARSE", "bad json"), { hasPersistedEvent: false })).toBe("contract_failure");
    expect(classifyRetryableModelError(new PiHarnessError("E_TAPE_HASH", "bad tape"), { hasPersistedEvent: false })).toBe("persistence_failure");
  });

  it("computes deterministic capped backoff without jitter", () => {
    expect(computeRetryDelayMs(1, 10, 25)).toBe(10);
    expect(computeRetryDelayMs(2, 10, 25)).toBe(20);
    expect(computeRetryDelayMs(3, 10, 25)).toBe(25);
    expect(computeRetryDelayMs(4, 10, 25)).toBe(25);
  });

  it("disables retries unless config is present and budget remains", () => {
    expect(shouldRetryModelInvocation({ retry: undefined, attempt: 1, classification: "model_open_transient" })).toBe(false);
    expect(shouldRetryModelInvocation({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }, attempt: 1, classification: "model_open_transient" })).toBe(true);
    expect(shouldRetryModelInvocation({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }, attempt: 3, classification: "model_open_transient" })).toBe(false);
    expect(shouldRetryModelInvocation({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }, attempt: 1, classification: "model_midstream_after_persist" })).toBe(false);
  });

  it("normalizes only code, name, and numeric status", () => {
    expect(normalizeRetryError({ code: "ECONNRESET", name: "SocketError", status: 503, ignored: true })).toEqual({
      code: "ECONNRESET",
      name: "SocketError",
      status: 503,
    });
  });

  it("reads transport codes out of the fetch cause chain", () => {
    // What undici actually throws: the outer error carries no code at all.
    const fetchFailed = new TypeError("fetch failed", { cause: transientError("ECONNRESET") });
    expect(normalizeRetryError(fetchFailed).code).toBe("ECONNRESET");
    expect(classifyRetryableModelError(fetchFailed, { hasPersistedEvent: false })).toBe("model_open_transient");

    // An SDK that re-wraps undici's error still classifies.
    const wrapped = new Error("provider request failed", { cause: fetchFailed });
    expect(classifyRetryableModelError(wrapped, { hasPersistedEvent: false })).toBe("model_open_transient");

    // undici's own timeout spellings count as transient too.
    expect(classifyRetryableModelError(
      new TypeError("fetch failed", { cause: transientError("UND_ERR_HEADERS_TIMEOUT") }),
      { hasPersistedEvent: false },
    )).toBe("model_open_transient");

    // A genuine non-transport failure still fails closed, and a cyclic
    // cause chain must terminate rather than spin.
    const cyclic = new Error("boom") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(classifyRetryableModelError(cyclic, { hasPersistedEvent: false })).toBe("model_open_fail_closed");
  });

  it("stops walking the cause chain after MAX_CAUSE_DEPTH wrappers", () => {
    // Depth is counted from the outer error: it plus four `cause` hops are
    // read, the fifth is not. A transport code five wrappers down therefore
    // fails closed instead of retrying.
    function wrap(inner: unknown, layers: number): Error {
      let current: Error = inner as Error;
      for (let i = 0; i < layers; i++) current = new Error(`layer ${i}`, { cause: current });
      return current;
    }
    expect(normalizeRetryError(wrap(transientError("ECONNRESET"), 4)).code).toBe("ECONNRESET");
    expect(classifyRetryableModelError(wrap(transientError("ECONNRESET"), 4), { hasPersistedEvent: false })).toBe("model_open_transient");
    expect(normalizeRetryError(wrap(transientError("ECONNRESET"), 5)).code).toBeNull();
    expect(classifyRetryableModelError(wrap(transientError("ECONNRESET"), 5), { hasPersistedEvent: false })).toBe("model_open_fail_closed");
  });

  it("keeps the outermost value of each field and fills only the missing ones from causes", () => {
    const outer = { code: "E_OUTER", cause: { code: "ECONNRESET", name: "SocketError", status: 503 } };
    expect(normalizeRetryError(outer)).toEqual({ code: "E_OUTER", name: "SocketError", status: 503 });
    // The outer code wins even though the cause carried a retryable one;
    // the cause's status still makes the whole error transient.
    expect(classifyRetryableModelError(outer, { hasPersistedEvent: false })).toBe("model_open_transient");
    expect(classifyRetryableModelError({ code: "E_OUTER", cause: { code: "ECONNRESET" } }, { hasPersistedEvent: false }))
      .toBe("model_open_fail_closed");
  });

  it("ignores non-string codes and non-numeric statuses, and matches the allowlist by name too", () => {
    expect(normalizeRetryError({ code: 42, status: "503", name: ["x"] })).toEqual({ code: null, name: null, status: null });
    expect(normalizeRetryError("ECONNRESET")).toEqual({ code: null, name: null, status: null });
    expect(classifyRetryableModelError({ name: "ETIMEDOUT" }, { hasPersistedEvent: false })).toBe("model_open_transient");
    // Only the transport allowlist is consulted for `name`; a generic Error
    // name does not qualify.
    expect(classifyRetryableModelError(new Error("ECONNRESET"), { hasPersistedEvent: false })).toBe("model_open_fail_closed");
  });

  it("rejects a non-positive attempt index instead of computing a delay from it", () => {
    expect(() => computeRetryDelayMs(0, 10, 25)).toThrow(PiHarnessError);
    expect(() => computeRetryDelayMs(-1, 10, 25)).toThrow(/attemptIndex must be >= 1/);
    // An E_MODEL_ADAPTER error is a PiHarnessError, so it is never treated
    // as transient regardless of its own `retryable` default.
    expect(classifyRetryableModelError(new PiHarnessError("E_MODEL_ADAPTER", "adapter"), { hasPersistedEvent: false }))
      .toBe("model_open_fail_closed");
  });
});
