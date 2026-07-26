import { accessSync, constants as fsConstants } from "node:fs";
import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";
import { spawn as spawnPty, type IPty } from "node-pty";

export type HermesTransportMode = "pty" | "subprocess";
export type HermesTransportStream = "pty" | "stdout" | "stderr";

export interface SpawnHermesTransportInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prefer: HermesTransportMode;
  cols?: number;
  rows?: number;
}

export interface HermesTransportExit {
  exitCode: number;
  signal?: number | string;
}

export interface HermesTransport {
  mode: HermesTransportMode;
  pid: number;
  backend: "node-pty" | "script" | "subprocess";
  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void;
  onExit(listener: (event: HermesTransportExit) => void): void;
  kill(signal?: string): void;
}

class PtyHermesTransport implements HermesTransport {
  mode: HermesTransportMode = "pty";
  backend: "node-pty" = "node-pty";
  pid: number;

  constructor(private readonly ptyProcess: IPty) {
    this.pid = ptyProcess.pid;
  }

  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void {
    this.ptyProcess.onData((chunk) => listener(chunk, "pty"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    this.ptyProcess.onExit((event) => listener(event));
  }

  kill(signal?: string): void {
    this.ptyProcess.kill(signal);
  }
}

class ScriptPtyHermesTransport implements HermesTransport {
  mode: HermesTransportMode = "pty";
  backend: "script" = "script";
  pid: number;

  constructor(private readonly child: ChildProcessByStdio<null, Readable, Readable>) {
    this.pid = child.pid ?? -1;
    child.on("error", () => { /* surfaced as exit 127 via onExit */ });
  }

  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer | string) => listener(decodeChunk(stdoutDecoder, chunk), "pty"));
    this.child.stderr.on("data", (chunk: Buffer | string) => listener(decodeChunk(stderrDecoder, chunk), "pty"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    attachExitListener(this.child, listener);
  }

  kill(signal?: string): void {
    killChild(this.child, signal);
  }
}

class SubprocessHermesTransport implements HermesTransport {
  mode: HermesTransportMode = "subprocess";
  backend: "subprocess" = "subprocess";
  pid: number;

  constructor(private readonly child: ChildProcessByStdio<null, Readable, Readable>) {
    this.pid = child.pid ?? -1;
    child.on("error", () => { /* surfaced as exit 127 via onExit */ });
  }

  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer | string) => listener(decodeChunk(stdoutDecoder, chunk), "stdout"));
    this.child.stderr.on("data", (chunk: Buffer | string) => listener(decodeChunk(stderrDecoder, chunk), "stderr"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    attachExitListener(this.child, listener);
  }

  kill(signal?: string): void {
    killChild(this.child, signal);
  }
}

export function spawnHermesTransport(input: SpawnHermesTransportInput): HermesTransport {
  const resolvedCommand = resolveExecutable(input.command, input.env) ?? input.command;

  if (input.prefer === "pty") {
    const scriptTransport = spawnScriptPtyTransport(resolvedCommand, input);
    if (scriptTransport) return scriptTransport;

    try {
      const ptyProcess = spawnPty(resolvedCommand, input.args, {
        name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
        cols: input.cols ?? 120,
        rows: input.rows ?? 30,
        cwd: input.cwd,
        env: input.env,
      });
      return new PtyHermesTransport(ptyProcess);
    } catch {
      // fall through to stdio pipes when PTY allocation is unavailable
    }
  }

  const child = spawnChildProcess(resolvedCommand, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new SubprocessHermesTransport(child);
}

function spawnScriptPtyTransport(command: string, input: SpawnHermesTransportInput): HermesTransport | null {
  const scriptPath = resolveExecutable("script", input.env);
  if (!scriptPath) return null;

  try {
    const child = spawnChildProcess(scriptPath, buildScriptPtyArgs(command, input.args, process.platform), {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    return new ScriptPtyHermesTransport(child);
  } catch {
    return null;
  }
}

/**
 * BSD script (macOS) and util-linux script (Linux) disagree on arguments.
 * BSD: `script -q /dev/null command arg...` runs the command directly.
 * util-linux ignores extra positional arguments, so the BSD form silently
 * spawns an interactive shell instead of the worker command. Linux needs
 * `script -qefc '<command>' /dev/null` (-e propagates the command's exit
 * code, -f flushes output as it streams).
 */
function buildScriptPtyArgs(command: string, args: string[], platform: NodeJS.Platform): string[] {
  if (platform === "linux") {
    return ["-qefc", [command, ...args].map(quoteForShell).join(" "), "/dev/null"];
  }
  return ["-q", "/dev/null", command, ...args];
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const hasExplicitPath = command.includes("/") || command.includes("\\") || isAbsolute(command);
  if (hasExplicitPath) {
    return isExecutable(command) ? command : null;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const candidates = process.platform === "win32"
    ? expandWindowsCandidates(command, env)
    : [command];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (isExecutable(fullPath)) return fullPath;
    }
  }

  return null;
}

function expandWindowsCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathext = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const lowerCommand = command.toLowerCase();
  if (pathext.some((ext) => lowerCommand.endsWith(ext.toLowerCase()))) {
    return [command];
  }
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`)];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pipe reads can split a multi-byte UTF-8 character across two 'data'
 * events; per-chunk toString() would turn each half into U+FFFD. A
 * per-stream StringDecoder carries the partial bytes to the next chunk.
 */
function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

function attachExitListener(child: ChildProcess, listener: (event: HermesTransportExit) => void): void {
  let settled = false;
  child.on("exit", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    listener({ exitCode: exitCode ?? 1, signal: signal ?? undefined });
  });
  child.on("error", () => {
    if (settled) return;
    settled = true;
    // Spawn failures (e.g. ENOENT) never emit 'exit'. Report the shell
    // convention for "command not found" instead of letting the unhandled
    // 'error' event crash the whole harness process.
    listener({ exitCode: 127 });
  });
}

function killChild(child: ChildProcess, signal?: string): void {
  const normalized = (signal as NodeJS.Signals | undefined) ?? "SIGTERM";
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, normalized);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  child.kill(normalized);
}

export const __testables = { resolveExecutable, buildScriptPtyArgs };
