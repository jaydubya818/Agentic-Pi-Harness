import { describe, it, expect } from "vitest";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";

describe("hook dispatcher concurrency + timeout", () => {
  it("fires hooks sequentially and short-circuits on deny", async () => {
    const order: string[] = [];
    const d = new HookDispatcher();
    d.register({
      pluginId: "a", event: "PreToolUse", timeoutMs: 200,
      fn: async () => { order.push("a"); return { outcome: "continue" }; },
    });
    d.register({
      pluginId: "b", event: "PreToolUse", timeoutMs: 200,
      fn: async () => { order.push("b"); return { outcome: "deny", reason: "nope" }; },
    });
    d.register({
      pluginId: "c", event: "PreToolUse", timeoutMs: 200,
      fn: async () => { order.push("c"); return { outcome: "continue" }; },
    });
    const { responses, audits } = await d.dispatch({
      event: "PreToolUse", sessionId: "s", turnIndex: 0, payload: {},
    });
    expect(order).toEqual(["a", "b"]);            // c never ran (short-circuit)
    expect(responses.map((r) => r.outcome)).toEqual(["continue", "deny"]);
    expect(audits.every((a) => a.exitCode === 0)).toBe(true);
    // canonical digests — stable length, sha256 prefix
    expect(audits[0].responseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("enforces per-hook timeout and emits exitCode=1 audit", async () => {
    const d = new HookDispatcher();
    d.register({
      pluginId: "slow", event: "PreToolUse", timeoutMs: 20,
      fn: () => new Promise((res) => setTimeout(() => res({ outcome: "continue" }), 200)),
    });
    d.register({
      pluginId: "fast", event: "PreToolUse", timeoutMs: 200,
      fn: async () => ({ outcome: "continue" }),
    });
    const { responses, audits } = await d.dispatch({
      event: "PreToolUse", sessionId: "s", turnIndex: 0, payload: {},
    });
    // timeout is recorded as a failed audit, not a thrown error
    expect(audits[0].pluginId).toBe("slow");
    expect(audits[0].exitCode).toBe(1);
    expect(audits[0].responseDigest).toBe("sha256:error");
    // fast hook still ran after the failure
    expect(audits[1].pluginId).toBe("fast");
    expect(audits[1].exitCode).toBe(0);
    expect(responses.length).toBe(1); // only the fast one produced a response
  });
});
