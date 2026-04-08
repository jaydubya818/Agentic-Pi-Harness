import { describe, it, expect } from "vitest";
import { runShellHook } from "../../src/hooks/shellHook.js";
import { PiHarnessError } from "../../src/errors.js";

const ctx = {
  event: "PreToolUse" as const,
  sessionId: "s1",
  turnIndex: 0,
  payload: { toolName: "rm", input: { path: "/" } },
};

describe("shell hook executor", () => {
  it("echoes a continue response", async () => {
    const script = `
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const msg = JSON.parse(d);
  process.stdout.write(JSON.stringify({ outcome: 'continue', reason: 'saw ' + msg.event }));
});`;
    const res = await runShellHook(
      { command: ["node", "-e", script], hardTimeoutMs: 5000 },
      ctx,
    );
    expect(res.outcome).toBe("continue");
    expect(res.reason).toBe("saw PreToolUse");
  });

  it("propagates deny with reason", async () => {
    const script = `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{"outcome":"deny","reason":"blocked"}'); });`;
    const res = await runShellHook(
      { command: ["node", "-e", script], hardTimeoutMs: 5000 },
      ctx,
    );
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("blocked");
  });

  it("rejects on non-zero exit with E_HOOK_SHELL", async () => {
    await expect(
      runShellHook({ command: ["node", "-e", "process.exit(2)"], hardTimeoutMs: 5000 }, ctx),
    ).rejects.toBeInstanceOf(PiHarnessError);
  });

  it("rejects on invalid JSON", async () => {
    await expect(
      runShellHook({ command: ["node", "-e", "process.stdout.write('not json')"], hardTimeoutMs: 5000 }, ctx),
    ).rejects.toBeInstanceOf(PiHarnessError);
  });

  it("rejects on empty command array", async () => {
    await expect(runShellHook({ command: [] }, ctx)).rejects.toBeInstanceOf(PiHarnessError);
  });
});
