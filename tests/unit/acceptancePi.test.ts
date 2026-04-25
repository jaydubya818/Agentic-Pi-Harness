import { describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiAcceptanceArgs, runPiAcceptance } from "../../src/cli/acceptance-pi.js";

describe("pi acceptance helper", () => {
  it("runs the golden path acceptance flow and returns artifact locations", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-acceptance-work-"));
    const outRoot = await mkdtemp(join(tmpdir(), "pi-acceptance-out-"));

    const result = await runPiAcceptance({ workdir, outRoot });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toMatch(/^golden-[a-z0-9-]+$/);
    expect(result.recordCount).toBeGreaterThan(0);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await access(result.tapePath);
    await access(result.effectLogPath);
    await access(result.policyLogPath);
    await access(result.checkpointPath);
  }, 10_000);

  it("parses positional workdir/outRoot and trace path", () => {
    const args = parsePiAcceptanceArgs(["./work", "./out", "--trace=./trace.jsonl"]);

    expect(args.workdir).toMatch(/\/work$/);
    expect(args.outRoot).toMatch(/\/out$/);
    expect(args.tracePath).toMatch(/\/trace\.jsonl$/);
  });
});
