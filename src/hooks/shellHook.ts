import { spawn } from "node:child_process";
import { HookContext, HookResponse, HookResponseSchema, InProcessHook } from "./dispatcher.js";
import { PiHarnessError } from "../errors.js";

/**
 * Shell-contract hook executor: runs an external process and exchanges a
 * single JSON payload over stdin/stdout. This is the bridge that lets hooks
 * be written in any language — Python, Ruby, a compiled binary, whatever.
 *
 * Contract:
 *   - stdin  (UTF-8): { event, sessionId, turnIndex, payload }
 *   - stdout (UTF-8): { outcome: "continue"|"deny"|"modify", reason?, patch? }
 *   - exit 0 on success; non-zero raises E_HOOK_SHELL.
 *   - Hard SIGKILL timeout guards against hung descendants.
 */
export interface ShellHookSpec {
  command: string[];
  env?: Record<string, string>;
  hardTimeoutMs?: number;
}

export function makeShellHook(spec: ShellHookSpec): InProcessHook {
  return (ctx: HookContext): Promise<HookResponse> => runShellHook(spec, ctx);
}

export function runShellHook(spec: ShellHookSpec, ctx: HookContext): Promise<HookResponse> {
  const hardTimeout = spec.hardTimeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    if (!spec.command.length) {
      reject(new PiHarnessError("E_HOOK_SHELL", "shell hook command is empty"));
      return;
    }
    const [cmd, ...args] = spec.command;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const kill = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, hardTimeout);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(kill);
      reject(new PiHarnessError("E_HOOK_SHELL", "shell hook spawn failed: " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      if (killed) {
        reject(new PiHarnessError("E_HOOK_SHELL", "shell hook SIGKILLed after " + hardTimeout + "ms", { stderr }));
        return;
      }
      if (code !== 0) {
        reject(new PiHarnessError("E_HOOK_SHELL", "shell hook exited " + code, { stderr, stdout }));
        return;
      }
      try {
        const parsed = HookResponseSchema.parse(JSON.parse(stdout.trim() || "{}"));
        resolve(parsed);
      } catch (e) {
        reject(new PiHarnessError("E_HOOK_SHELL", "shell hook produced invalid JSON: " + String(e), { stdout }));
      }
    });
    child.stdin.write(JSON.stringify({
      event: ctx.event,
      sessionId: ctx.sessionId,
      turnIndex: ctx.turnIndex,
      payload: ctx.payload,
    }));
    child.stdin.end();
  });
}
