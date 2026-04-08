import { describe, it, expect } from "vitest";
import { CostTracker, estimateTokens, CostTable } from "../../src/metrics/cost.js";

const table: CostTable = {
  version: "test",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputPer1k: 3.0,
  outputPer1k: 15.0,
};

describe("CostTracker", () => {
  it("estimates tokens at 4 chars each (ceil, min 1)", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("accumulates text_delta as output tokens and tool_result as input", () => {
    const t = new CostTracker(table);
    t.observe({ type: "text_delta", schemaVersion: 1, text: "abcd" });
    t.observe({ type: "text_delta", schemaVersion: 1, text: "efgh" });
    t.observe({ type: "tool_result", schemaVersion: 1, id: "t1", output: "12345678", isError: false });
    const snap = t.snapshot();
    expect(snap.outputTokens).toBe(2);
    expect(snap.inputTokens).toBe(2);
    expect(snap.usd).toBeGreaterThan(0);
    expect(snap.provider).toBe("anthropic");
  });

  it("reports zero usd for a zero-priced table", () => {
    const free: CostTable = { ...table, inputPer1k: 0, outputPer1k: 0 };
    const t = new CostTracker(free);
    t.observe({ type: "text_delta", schemaVersion: 1, text: "hello world" });
    expect(t.snapshot().usd).toBe(0);
  });
});
