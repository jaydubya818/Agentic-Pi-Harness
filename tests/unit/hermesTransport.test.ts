import { describe, expect, it } from "vitest";
import { spawnHermesTransport, type HermesTransportExit } from "../../src/hermes/transport.js";

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
});
