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
});
