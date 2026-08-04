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

  it("survives a hook that exits without reading its stdin payload", async () => {
    // A large payload overflows the pipe buffer, so the write finishes after
    // the child has already exited and stdin raises EPIPE. Without an error
    // handler on stdin that crashes the process instead of resolving.
    const bigCtx = { ...ctx, payload: { blob: "x".repeat(1 << 21) } };
    const script = `process.stdout.write('{"outcome":"continue"}');`;
    const res = await runShellHook(
      { command: ["node", "-e", script], hardTimeoutMs: 5000 },
      bigCtx,
    );
    expect(res.outcome).toBe("continue");
  });

  it("SIGKILLs a hung hook and its descendants at the hard timeout", async () => {
    const script = `
const { spawn } = require('child_process');
const c = spawn('sleep', ['30']);
process.stderr.write('pid=' + c.pid + '\\n');
process.stdin.resume();
setTimeout(() => {}, 30000);`;
    let caught: unknown;
    try {
      await runShellHook({ command: ["node", "-e", script], hardTimeoutMs: 500 }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PiHarnessError);
    expect((caught as PiHarnessError).message).toContain("SIGKILLed");

    // The grandchild must have died with the process group.
    const stderr = String((caught as PiHarnessError).context.stderr ?? "");
    const match = /pid=(\d+)/.exec(stderr);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match![1]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
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

  it("rejects a hook that floods stdout past the capture cap", async () => {
    const script = `
const chunk = Buffer.alloc(1 << 20, 97);
for (let i = 0; i < 8; i++) process.stdout.write(chunk);
`;
    await expect(
      runShellHook({ command: ["node", "-e", script], hardTimeoutMs: 10000 }, ctx),
    ).rejects.toThrow(/stdout exceeded/);
  });

  it("clears the hook environment except PATH, HOME, and PI_* variables", async () => {
    // docs/HOOK-SECURITY.md contract item 6 + review checklist: a hook that
    // dumps its env must not see harness secrets, but still gets PATH plus
    // the PI_HOOK_EVENT / PI_SESSION_ID correlation vars and manifest env.
    process.env.PI_TEST_FAKE_SECRET = "hunter2";
    try {
      const script = `process.stdin.resume(); process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ outcome: 'continue', reason: JSON.stringify({
          secret: process.env.PI_TEST_FAKE_SECRET ?? null,
          event: process.env.PI_HOOK_EVENT ?? null,
          session: process.env.PI_SESSION_ID ?? null,
          extra: process.env.HOOK_EXTRA ?? null,
        }) }));
      });`;
      const res = await runShellHook(
        { command: ["node", "-e", script], env: { HOOK_EXTRA: "yes" }, hardTimeoutMs: 5000 },
        ctx,
      );
      const seen = JSON.parse(res.reason!);
      expect(seen.secret).toBeNull();
      expect(seen.event).toBe("PreToolUse");
      expect(seen.session).toBe("s1");
      expect(seen.extra).toBe("yes");
    } finally {
      delete process.env.PI_TEST_FAKE_SECRET;
    }
  });

  it("runs the hook in a scratch directory, not the harness cwd", async () => {
    // docs/HOOK-SECURITY.md contract item 5: hooks cannot read session files
    // via relative paths because they start in a throwaway scratch dir.
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ outcome: 'continue', reason: process.cwd() }));
    });`;
    const res = await runShellHook({ command: ["node", "-e", script], hardTimeoutMs: 5000 }, ctx);
    expect(res.reason).toContain("pi-hook-");
    expect(res.reason).not.toBe(process.cwd());
  });

  it("rejects on empty command array", async () => {
    await expect(runShellHook({ command: [] }, ctx)).rejects.toBeInstanceOf(PiHarnessError);
  });
});
