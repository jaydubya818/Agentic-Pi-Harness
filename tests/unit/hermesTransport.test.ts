import { describe, expect, it } from "vitest";
import { __testables, spawnHermesTransport, type HermesTransportExit } from "../../src/hermes/transport.js";

function waitForExit(transport: { onExit(listener: (event: HermesTransportExit) => void): void }): Promise<HermesTransportExit> {
  return new Promise((resolve) => transport.onExit(resolve));
}

describe("hermes transport", () => {
  it("surfaces a missing executable as exit 127 instead of an unhandled 'error' crash", async () => {
    const transport = spawnHermesTransport({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      cwd: process.cwd(),
      env: { PATH: "/nonexistent" },
      prefer: "subprocess",
    });
    const exit = await waitForExit(transport);
    expect(exit.exitCode).toBe(127);
  });

  it("reassembles multi-byte characters split across output chunks", async () => {
    const script = `
const b = Buffer.from("caf\u00e9", "utf8");
process.stdout.write(b.subarray(0, 4));
setTimeout(() => { process.stdout.write(b.subarray(4)); process.exit(0); }, 100);`;
    const transport = spawnHermesTransport({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      prefer: "subprocess",
    });
    let output = "";
    transport.onOutput((chunk) => { output += chunk; });
    await waitForExit(transport);
    expect(output).toBe("caf\u00e9");
    expect(output).not.toContain("\uFFFD");
  });

  it("does not resolve PATH lookups to directories (X_OK passes on dirs)", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "pi-transport-path-"));
    try {
      await mkdir(join(base, "dir-named-like-cmd"));
      expect(__testables.resolveExecutable("dir-named-like-cmd", { PATH: base })).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not resolve an empty command to a PATH directory", () => {
    // join(dir, "") === dir, so an empty command used to resolve to the
    // first searchable PATH entry itself.
    expect(__testables.resolveExecutable("", { PATH: "/usr/bin" })).toBeNull();
  });

  it("still reports real exit codes for commands that run", async () => {
    const transport = spawnHermesTransport({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      env: process.env,
      prefer: "subprocess",
    });
    const exit = await waitForExit(transport);
    expect(exit.exitCode).toBe(3);
  });

  it("kills worker-spawned descendants when the subprocess transport is killed", async () => {
    if (process.platform === "win32") return;
    const script = `
const cp = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
console.log("GRANDCHILD=" + cp.pid);
setInterval(() => {}, 1000);`;
    const transport = spawnHermesTransport({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      prefer: "subprocess",
    });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("no grandchild pid announced")), 5000);
      transport.onOutput((chunk) => {
        output += chunk;
        const match = output.match(/GRANDCHILD=(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });

    transport.kill("SIGTERM");
    await waitForExit(transport);

    const deadline = Date.now() + 2000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (alive) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* cleanup */ }
    }
    expect(alive).toBe(false);
  }, 10000);

  it("builds util-linux script args on linux (BSD form silently runs a shell instead)", () => {
    const args = __testables.buildScriptPtyArgs("/usr/bin/hermes", ["chat", "-q", "hello world"], "linux");
    expect(args).toEqual(["-qefc", "'/usr/bin/hermes' 'chat' '-q' 'hello world'", "/dev/null"]);
  });

  it("shell-quotes single quotes in script args on linux", () => {
    const args = __testables.buildScriptPtyArgs("hermes", ["it's a prompt"], "linux");
    expect(args[1]).toBe("'hermes' 'it'\\''s a prompt'");
  });

  it("keeps the BSD script arg form on darwin", () => {
    const args = __testables.buildScriptPtyArgs("hermes", ["chat", "-q", "hi"], "darwin");
    expect(args).toEqual(["-q", "/dev/null", "hermes", "chat", "-q", "hi"]);
  });

  it("runs the requested command through the script pty transport", async () => {
    const transport = spawnHermesTransport({
      command: process.execPath,
      args: ["-e", "console.log('pty-transport-hello'); process.exit(7)"],
      cwd: process.cwd(),
      env: process.env,
      prefer: "pty",
    });
    let output = "";
    transport.onOutput((chunk) => { output += chunk; });
    const exit = await waitForExit(transport);
    expect(output).toContain("pty-transport-hello");
    if (process.platform === "linux" && transport.backend === "script") {
      expect(exit.exitCode).toBe(7);
    }
  }, 15000);
});
