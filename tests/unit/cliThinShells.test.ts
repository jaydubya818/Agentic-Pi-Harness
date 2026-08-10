import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayTape } from "../../src/cli/replay.js";
import { whatChanged } from "../../src/cli/what-changed.js";
import { inspectPolicy } from "../../src/cli/inspect.js";
import { __testables as hermesBridgeTestables } from "../../src/cli/hermes-bridge.js";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { appendEffectRecord } from "../../src/effect/recorder.js";
import { appendPolicyDecision, placeholderApprove } from "../../src/policy/decision.js";

describe("thin CLIs", () => {
  it("replay CLI renders from library tape records after verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cli-replay-"));
    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({
      sessionId: "session-1",
      loopGitSha: "dev",
      policyDigest: "sha256:policy-test",
      costTableVersion: "2026-04-01",
      createdAt: "2026-04-08T00:00:00.000Z",
    });
    await tape.writeEvent({ type: "message_start", schemaVersion: 1 });
    await tape.writeEvent({ type: "message_stop", schemaVersion: 1, stopReason: "end_turn" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await replayTape(tapePath);
      expect(code).toBe(0);
      expect(errSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
        "# header session=session-1 policy=sha256:policy-test",
        "[1] message_start",
        "[2] message_stop (end_turn)",
        expect.stringContaining("ok 3 records digest="),
      ]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("what-changed CLI delegates to the effect log library", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cli-effects-"));
    const path = join(dir, "effects.jsonl");
    await appendEffectRecord(path, {
      schemaVersion: 1,
      toolCallId: "tool-1",
      sessionId: "session-1",
      toolName: "write_file",
      paths: ["/tmp/file.txt"],
      preHashes: { "/tmp/file.txt": "sha256:before" },
      postHashes: { "/tmp/file.txt": "sha256:after" },
      unifiedDiff: "--- a//tmp/file.txt\n+++ b//tmp/file.txt\n",
      binaryChanged: false,
      timestamp: "2026-04-08T00:00:00Z",
    });

    const output = await whatChanged(path);
    expect(output).toContain("# write_file (tool-1)");
    expect(output).toContain("/tmp/file.txt");
  });

  it("inspect CLI delegates to the policy log library", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cli-policy-"));
    const path = join(dir, "policy.jsonl");
    await appendPolicyDecision(path, placeholderApprove({
      toolCallId: "tool-1",
      modeInfluence: "assist",
      policyDigest: "sha256:policy-test",
      at: "2026-04-08T00:00:00Z",
    }));

    const output = await inspectPolicy(path);
    expect(output).toContain("tool-1 approve provenance=placeholder");
    expect(output).toContain("policyDigest=sha256:policy-test");
  });
});

describe("hermes-bridge cli args", () => {
  it("rejects non-numeric and out-of-range --port values with a clean error", () => {
    expect(() => hermesBridgeTestables.parseArgs(["--port", "abc"])).toThrow(/invalid --port/);
    expect(() => hermesBridgeTestables.parseArgs(["--port", "70000"])).toThrow(/invalid --port/);
    expect(() => hermesBridgeTestables.parseArgs(["--port", "8.5"])).toThrow(/invalid --port/);
    // Number() accepts hex and exponent spellings; the shared strict helper
    // must reject them here the same way it does for every other int flag.
    expect(() => hermesBridgeTestables.parseArgs(["--port", "0x1f90"])).toThrow(/invalid --port/);
    expect(() => hermesBridgeTestables.parseArgs(["--port", "8e3"])).toThrow(/invalid --port/);
    expect(hermesBridgeTestables.parseArgs(["--port", "8080"]).port).toBe(8080);
    expect(hermesBridgeTestables.parseArgs([]).port).toBe(8787);
  });
});

describe("hermes cli unknown/valueless flag rejection", () => {
  it("rejects mistyped flags instead of silently using defaults", async () => {
    const run = (await import("../../src/cli/hermes-run.js")).__testables;
    const smoke = (await import("../../src/cli/hermes-smoke.js")).__testables;
    const demo = (await import("../../src/cli/hermes-demo.js")).__testables;
    expect(() => run.parseArgs(["--objectve", "do things"])).toThrow(/unknown flag: --objectve/);
    expect(() => smoke.parseArgs(["--outputdir", "/tmp/x"])).toThrow(/unknown flag: --outputdir/);
    expect(() => demo.parseArgs(["--timeout-seconds", "60"])).toThrow(/unknown flag: --timeout-seconds/);
    expect(() => hermesBridgeTestables.parseArgs(["--prot", "8080"])).toThrow(/unknown flag: --prot/);
  });

  it("rejects a known flag whose trailing value is missing", async () => {
    const run = (await import("../../src/cli/hermes-run.js")).__testables;
    const { parseHermesDoctorArgs } = await import("../../src/cli/hermes-doctor.js");
    expect(() => run.parseArgs(["--objective"])).toThrow(/--objective requires a value/);
    expect(() => hermesBridgeTestables.parseArgs(["--auth-token"])).toThrow(/--auth-token requires a value/);
    expect(() => parseHermesDoctorArgs(["--url"])).toThrow(/--url requires a value/);
  });

  it("still accepts full valid invocations", async () => {
    const run = (await import("../../src/cli/hermes-run.js")).__testables;
    const args = run.parseArgs(["--objective", "do things", "--timeout", "60", "--bridge-url", "http://127.0.0.1:1"]);
    expect(args.objective).toBe("do things");
    expect(args.timeoutSeconds).toBe(60);
    expect(args.bridgeUrl).toBe("http://127.0.0.1:1");
  });
});

describe("hermes cli numeric flag validation", () => {
  it("hermes-run rejects invalid --timeout values with a clean error", async () => {
    const { __testables } = await import("../../src/cli/hermes-run.js");
    expect(() => __testables.parseArgs(["--timeout", "abc"])).toThrow(/invalid --timeout/);
    expect(() => __testables.parseArgs(["--timeout", "0"])).toThrow(/invalid --timeout/);
    expect(() => __testables.parseArgs(["--timeout", "12.5"])).toThrow(/invalid --timeout/);
    expect(__testables.parseArgs(["--timeout", "120"]).timeoutSeconds).toBe(120);
    expect(__testables.parseArgs([]).timeoutSeconds).toBe(900);
  });

  it("hermes-smoke and hermes-demo reject invalid --timeout values", async () => {
    const smoke = (await import("../../src/cli/hermes-smoke.js")).__testables;
    const demo = (await import("../../src/cli/hermes-demo.js")).__testables;
    expect(() => smoke.parseArgs(["--timeout", "never"])).toThrow(/invalid --timeout/);
    expect(smoke.parseArgs(["--timeout", "60"]).timeoutSeconds).toBe(60);
    expect(() => demo.parseArgs(["--timeout", "-5"])).toThrow(/invalid --timeout/);
    expect(demo.parseArgs(["--timeout", "60"]).timeoutSeconds).toBe(60);
  });

  it("hermes-doctor rejects invalid --timeout-ms and acceptance rejects invalid --port", async () => {
    const { parseHermesDoctorArgs } = await import("../../src/cli/hermes-doctor.js");
    const { parseHermesAcceptanceArgs } = await import("../../src/cli/acceptance-hermes.js");
    expect(() => parseHermesDoctorArgs(["--timeout-ms", "abc"])).toThrow(/invalid --timeout-ms/);
    expect(parseHermesDoctorArgs(["--timeout-ms", "5000"]).timeoutMs).toBe(5000);
    expect(() => parseHermesAcceptanceArgs(["--port", "70000"])).toThrow(/invalid --port/);
    expect(parseHermesAcceptanceArgs(["--port", "8080"]).port).toBe(8080);
  });
});
