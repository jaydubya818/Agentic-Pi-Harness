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
