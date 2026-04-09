import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { readPolicyLog } from "../../src/policy/decision.js";
import { readTape, ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { StreamEvent, TapeEventRecord } from "../../src/schemas/index.js";

describe("query loop compaction", () => {
  it("applies compaction only to the runtime compacted view and leaves tape truth unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-compact-loop-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    const bigOutput = "x".repeat(4000);
    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient([
        { type: "message_start", schemaVersion: 1 },
        { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: target } },
        { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
      ]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      compactTargetBytes: 100,
      tools: {
        read_file: async (input: { path: string }) => ({
          output: bigOutput,
          paths: [input.path],
        }),
      },
    });

    expect(result.compactions).toHaveLength(1);
    expect(result.compactions[0].strategy).toBe("compact_tool_result_bodies");
    expect(result.compactedEvents).not.toEqual(result.events);
    expect((result.events[2] as Extract<StreamEvent, { type: "tool_result" }>).output).toContain(bigOutput);
    const compactedOutput = (result.compactedEvents[2] as Extract<StreamEvent, { type: "tool_result" }>).output;
    expect(compactedOutput).toBe(`[compacted tool_result id=t1 bytes=${Buffer.byteLength((result.events[2] as Extract<StreamEvent, { type: "tool_result" }>).output, "utf8")}]`);
    expect(result.counters["compaction.applied"]).toBe(1);
    expect(result.counters["compaction.tool_results"]).toBe(1);

    const tapeRecords = await readTape(tapePath);
    const tapeEvents = tapeRecords
      .filter((record): record is TapeEventRecord => record.type === "event")
      .map((record) => record.event);
    expect(tapeEvents).toEqual(result.events);
    expect((tapeEvents[2] as Extract<StreamEvent, { type: "tool_result" }>).output).toContain(bigOutput);
    expect((await verifyTape(tapePath)).ok).toBe(true);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(1);
    await expect(readEffectLog(effectLogPath)).rejects.toMatchObject({ code: "E_SCHEMA_PARSE" });
    expect(await readFile(target, "utf8")).toBe("original\n");
  });
});
