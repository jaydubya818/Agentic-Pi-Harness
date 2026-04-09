import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { appendPolicyDecision, placeholderApprove } from "../../src/policy/decision.js";
import { appendEffectRecord } from "../../src/effect/recorder.js";
import { buildReplayDebugTimeline, renderReplayDebugTimeline } from "../../src/replay/debugger.js";

describe("replay debugger", () => {
  it("renders a readable merged timeline from existing persisted artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-debugger-"));
    const tapePath = join(dir, "tape.jsonl");
    const policyPath = join(dir, "policy.jsonl");
    const effectPath = join(dir, "effects.jsonl");

    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });
    await tape.writeEvent({ type: "message_start", schemaVersion: 1 });
    await tape.writeEvent({ type: "tool_use", schemaVersion: 1, id: "t1", name: "write_file", input: { path: "a.txt", content: "x" } });
    await tape.writeEvent({ type: "tool_result", schemaVersion: 1, id: "t1", output: "ok", isError: false });
    await tape.writeEvent({ type: "message_stop", schemaVersion: 1, stopReason: "end_turn" });

    await appendPolicyDecision(policyPath, placeholderApprove({
      toolCallId: "t1",
      modeInfluence: "assist",
      policyDigest: "sha256:policy",
      at: "2026-04-10T00:00:01Z",
    }));
    await appendEffectRecord(effectPath, {
      schemaVersion: 1,
      toolCallId: "t1",
      sessionId: "s1",
      toolName: "write_file",
      paths: ["a.txt"],
      preHashes: { "a.txt": "sha256:before" },
      postHashes: { "a.txt": "sha256:after" },
      unifiedDiff: "--- a/a.txt\n+++ b/a.txt\n",
      binaryChanged: false,
      timestamp: "2026-04-10T00:00:02Z",
    });

    const timeline = await buildReplayDebugTimeline({ tapePath, policyPath, effectPath });
    const rendered = renderReplayDebugTimeline(timeline);

    expect(timeline).toHaveLength(4);
    expect(rendered).toContain("[2] tool_use write_file#t1 decision=approve");
    expect(rendered).toContain("[3] tool_result #t1 isError=false effect=write_file");
  });
});
