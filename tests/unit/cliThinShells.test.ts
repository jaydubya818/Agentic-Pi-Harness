import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayTape } from "../../src/cli/replay.js";
import { whatChanged } from "../../src/cli/what-changed.js";
import { inspectPolicy } from "../../src/cli/inspect.js";
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
