import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbUsage, runKbCli } from "../../src/cli/kb.js";

describe("kb CLI", () => {
  it("prints usage shape for invalid commands", () => {
    expect(kbUsage()).toBe("usage: kb session acceptance <hermes|pi> [args]");
  });

  it("runs the pi acceptance flow through kb session acceptance pi", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "kb-pi-acceptance-work-"));
    const outRoot = await mkdtemp(join(tmpdir(), "kb-pi-acceptance-out-"));

    const code = await runKbCli(["session", "acceptance", "pi", workdir, outRoot]);

    expect(code).toBe(0);
  }, 10_000);
});
