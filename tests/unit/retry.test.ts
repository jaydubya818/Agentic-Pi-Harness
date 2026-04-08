import { describe, it, expect } from "vitest";
import { withRetry, defaultClassify } from "../../src/retry/stateMachine.js";

describe("withRetry", () => {
  it("succeeds after transient failures", async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n++;
      if (n < 3) throw new Error("ECONNRESET");
      return "ok";
    }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, classify: defaultClassify });
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("throws fatal immediately", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("syntax"); },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, classify: defaultClassify })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("converts context overflow into budget error", async () => {
    await expect(withRetry(async () => { throw new Error("context length exceeded"); },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, classify: defaultClassify })).rejects.toThrow(/context overflow/);
  });
});
