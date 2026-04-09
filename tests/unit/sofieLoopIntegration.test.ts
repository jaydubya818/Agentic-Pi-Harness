import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { StreamEvent } from "../../src/schemas/index.js";

function script(target: string): StreamEvent[] {
  return [
    { type: "message_start", schemaVersion: 1 },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "write_file", input: { path: target, content: "patched\n" } },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];
}

describe("Sofie loop seam", () => {
  it("returns bounded routine operator guidance when enabled and leaves tape semantics unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sofie-loop-"));
    const target = join(dir, "f.txt");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script(target)),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      policyMode: "placeholder",
      policyDigest: "sha256:policy",
      sofie: {
        enabled: true,
        question: "What routine operator guidance applies now?",
        kind: "operator",
      },
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    expect(result.sofieAnswer?.actor).toBe("sofie");
    expect(result.sofieAnswer?.escalation.escalate).toBe(false);
    expect((await verifyTape(tapePath)).ok).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(["message_start", "tool_use", "tool_result", "message_stop"]);
  });

  it("preserves default behavior when Sofie is not engaged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sofie-off-"));
    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient([{ type: "message_start", schemaVersion: 1 }, { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" }]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      policyMode: "placeholder",
      policyDigest: "sha256:policy",
      tools: {},
    });

    expect(result.sofieAnswer).toBeNull();
    expect((await verifyTape(tapePath)).ok).toBe(true);
  });
});
