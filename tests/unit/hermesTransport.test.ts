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
