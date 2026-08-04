import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Hook responses are a single small JSON object; a hook that streams
 * megabytes is misbehaving. Capping capture keeps a runaway hook from
 * ballooning harness memory while the hard timeout winds down.
 */
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

export function makeShellHook(spec: ShellHookSpec): InProcessHook {
  return (ctx: HookContext): Promise<HookResponse> => runShellHook(spec, ctx);
}

export async function runShellHook(spec: ShellHookSpec, ctx: HookContext): Promise<HookResponse> {
  if (!spec.command.length) {
    throw new PiHarnessError("E_HOOK_SHELL", "shell hook command is empty");
  }
  // docs/HOOK-SECURITY.md contract item 5: hooks run in a private scratch
  // dir, not the session workdir, so a hook cannot read session files via
  // relative paths — it only sees what the harness passes in `payload`.
  const scratchDir = await mkdtemp(join(tmpdir(), "pi-hook-"));
  try {
    return await spawnShellHook(spec, ctx, scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function spawnShellHook(spec: ShellHookSpec, ctx: HookContext, cwd: string): Promise<HookResponse> {
  const hardTimeout = spec.hardTimeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = spec.command;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: buildHookEnv(spec, ctx),
      // Own process group (POSIX) so the hard timeout can SIGKILL the whole
      // tree, not just the direct child.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let killed = false;
    const kill = setTimeout(() => {
      killed = true;
      killHookTree(child);
    }, hardTimeout);
    child.stdout.on("data", (d) => {
      if (stdout.length >= MAX_CAPTURE_CHARS) { stdoutOverflow = true; return; }
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length >= MAX_CAPTURE_CHARS) return;
      stderr += d.toString("utf8");
    });
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
      if (stdoutOverflow) {
        reject(new PiHarnessError("E_HOOK_SHELL", "shell hook stdout exceeded " + MAX_CAPTURE_CHARS + " bytes"));
        return;
      }
      try {
        const parsed = HookResponseSchema.parse(JSON.parse(stdout.trim() || "{}"));
        resolve(parsed);
      } catch (e) {
        reject(new PiHarnessError("E_HOOK_SHELL", "shell hook produced invalid JSON: " + String(e), { stdout }));
      }
    });
    child.stdin.on("error", () => {
      // EPIPE: the hook exited (or closed stdin) before reading the payload.
      // The 'close' handler still settles the promise from exit code + stdout.
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

/**
 * docs/HOOK-SECURITY.md contract item 6: the hook environment is cleared
 * except PATH, HOME, PI_HOOK_EVENT, and PI_SESSION_ID. Hooks are untrusted
 * executables and must never inherit harness secrets (ANTHROPIC_API_KEY,
 * AWS_*, tokens in env). Manifest-declared `spec.env` entries layer on top.
 */
function buildHookEnv(spec: ShellHookSpec, ctx: HookContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PI_HOOK_EVENT: ctx.event,
    PI_SESSION_ID: ctx.sessionId,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return { ...env, ...(spec.env ?? {}) };
}

/**
 * SIGKILL the hook's whole process group so hung descendants die with it.
 * Falls back to killing the direct child (Windows, or if the group is gone).
 */
function killHookTree(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch { /* fall through to direct kill */ }
  }
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}
