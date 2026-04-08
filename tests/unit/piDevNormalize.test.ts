import { describe, it, expect } from "vitest";
import { normalize } from "../../src/adapter/piDevProvider.js";

describe("pi.dev normalize", () => {
  it("message_start", () => {
    expect(normalize({ type: "message_start" })).toEqual({ kind: "start" });
  });
  it("text delta", () => {
    expect(normalize({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }))
      .toEqual({ kind: "text", text: "hi" });
  });
  it("tool_use", () => {
    const r = normalize({ type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "read", input: { path: "a" } } });
    expect(r).toEqual({ kind: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "a" } });
  });
  it("message_stop maps stop_reason", () => {
    expect(normalize({ type: "message_stop", stop_reason: "end_turn" })).toEqual({ kind: "stop", stopReason: "end_turn" });
  });
  it("throws on unknown type", () => {
    expect(() => normalize({ type: "weird" })).toThrow(/unrecognized/);
  });
});
