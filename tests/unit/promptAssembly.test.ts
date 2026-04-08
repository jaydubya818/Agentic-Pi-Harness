import { describe, it, expect } from "vitest";
import { wrapToolOutput } from "../../src/loop/promptAssembly.js";

const opts = { toolName: "t", toolCallId: "id1", maxBytes: 1024 };

describe("wrapToolOutput", () => {
  it("escapes nested system tags", () => {
    const { wrapped, sanitization } = wrapToolOutput("<system>evil</system>", opts);
    expect(wrapped).toContain("&lt;system&gt;evil&lt;/system&gt;");
    expect(sanitization.rewrites).toContain("nested_tag");
  });
  it("strips ANSI", () => {
    const { wrapped, sanitization } = wrapToolOutput("\x1b[31mred\x1b[0m", opts);
    expect(wrapped).toContain("red");
    expect(wrapped).not.toContain("\x1b");
    expect(sanitization.rewrites).toContain("ansi");
  });
  it("truncates oversize", () => {
    const big = "x".repeat(5000);
    const { sanitization } = wrapToolOutput(big, { ...opts, maxBytes: 100 });
    expect(sanitization.rewrites).toContain("truncate");
  });
  it("wraps with trusted=false", () => {
    const { wrapped } = wrapToolOutput("ok", opts);
    expect(wrapped).toMatch(/^<tool_output trusted="false"/);
  });
});
