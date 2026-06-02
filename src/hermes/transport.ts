import { accessSync, constants as fsConstants } from "node:fs";
import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
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
    this.ptyProcess.onData((chunk: string) => listener(chunk, "pty"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    this.ptyProcess.onExit((event: HermesTransportExit) => listener(event));
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
  }

  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void {
    this.child.stdout.on("data", (chunk: Buffer | string) => listener(chunk.toString(), "pty"));
    this.child.stderr.on("data", (chunk: Buffer | string) => listener(chunk.toString(), "pty"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    this.child.on("exit", (exitCode, signal) => listener({
      exitCode: exitCode ?? 1,
      signal: signal ?? undefined,
    }));
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
  }

  onOutput(listener: (chunk: string, stream: HermesTransportStream) => void): void {
    this.child.stdout.on("data", (chunk: Buffer | string) => listener(chunk.toString(), "stdout"));
    this.child.stderr.on("data", (chunk: Buffer | string) => listener(chunk.toString(), "stderr"));
  }

  onExit(listener: (event: HermesTransportExit) => void): void {
    this.child.on("exit", (exitCode, signal) => listener({
      exitCode: exitCode ?? 1,
      signal: signal ?? undefined,
    }));
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
    const child = spawnChildProcess(scriptPath, ["-q", "/dev/null", command, ...input.args], {
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

export const __testables = { resolveExecutable };
