import { describe, it, expect } from "vitest";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";

describe("HookDispatcher", () => {
  it("dispatches to matching event only", async () => {
    const d = new HookDispatcher();
    const calls: string[] = [];
    d.register({ pluginId: "p1", event: "PreToolUse", timeoutMs: 100, fn: () => { calls.push("pre"); return { outcome: "continue" }; } });
    d.register({ pluginId: "p2", event: "PostToolUse", timeoutMs: 100, fn: () => { calls.push("post"); return { outcome: "continue" }; } });
    await d.dispatch({ event: "PreToolUse", sessionId: "s", turnIndex: 0, payload: {} });
    expect(calls).toEqual(["pre"]);
  });

  it("stops on deny", async () => {
    const d = new HookDispatcher();
    const calls: string[] = [];
    d.register({ pluginId: "a", event: "PreToolUse", timeoutMs: 100, fn: () => { calls.push("a"); return { outcome: "deny", reason: "nope" }; } });
    d.register({ pluginId: "b", event: "PreToolUse", timeoutMs: 100, fn: () => { calls.push("b"); return { outcome: "continue" }; } });
    const { responses } = await d.dispatch({ event: "PreToolUse", sessionId: "s", turnIndex: 0, payload: {} });
    expect(responses[0].outcome).toBe("deny");
    expect(calls).toEqual(["a"]);
  });

  it("times out and audits exit 1", async () => {
    const d = new HookDispatcher();
    d.register({ pluginId: "slow", event: "PreToolUse", timeoutMs: 10,
      fn: () => new Promise((r) => setTimeout(() => r({ outcome: "continue" }), 200)) });
    const { responses, audits } = await d.dispatch({ event: "PreToolUse", sessionId: "s", turnIndex: 0, payload: {} });
    expect(responses).toEqual([]);
    expect(audits[0].exitCode).toBe(1);
  });
});
