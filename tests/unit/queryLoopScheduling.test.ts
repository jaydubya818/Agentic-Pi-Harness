import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { readPolicyLog } from "../../src/policy/decision.js";
import { readTape, ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { StreamEvent, TapeEventRecord } from "../../src/schemas/index.js";
import { ConcurrencyClassifier } from "../../src/tools/concurrency.js";

describe("query loop scheduling", () => {
  it("runs adjacent readonly tools in parallel while collating visible results in original order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sched-readonly-"));
    const targetA = join(dir, "a.txt");
    const targetB = join(dir, "b.txt");
    await writeFile(targetA, "a\n", "utf8");
    await writeFile(targetB, "b\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    let activeReads = 0;
    let maxActiveReads = 0;
    const starts: string[] = [];
    const finishes: string[] = [];

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient([
        { type: "message_start", schemaVersion: 1 },
        { type: "tool_use", schemaVersion: 1, id: "r1", name: "read_file", input: { path: targetA } },
        { type: "tool_use", schemaVersion: 1, id: "r2", name: "read_file", input: { path: targetB } },
        { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
      ]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      concurrency: new ConcurrencyClassifier([{ name: "read_file", class: "readonly" }]),
      tools: {
        read_file: async (input: { path: string }) => {
          starts.push(input.path === targetA ? "r1" : "r2");
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, input.path === targetA ? 20 : 1));
          activeReads -= 1;
          finishes.push(input.path === targetA ? "r1" : "r2");
          return { output: input.path === targetA ? "A" : "B", paths: [input.path] };
        },
      },
    });

    expect(maxActiveReads).toBeGreaterThanOrEqual(2);
    expect(starts).toEqual(["r1", "r2"]);
    expect(result.events.map((event) => event.type)).toEqual([
      "message_start",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
      "message_stop",
    ]);
    expect((result.events[3] as Extract<StreamEvent, { type: "tool_result" }>).id).toBe("r1");
    expect((result.events[4] as Extract<StreamEvent, { type: "tool_result" }>).id).toBe("r2");
    expect(finishes).not.toEqual(["r1", "r2"]);
    expect(result.effects).toHaveLength(0);
    expect(result.decisions).toHaveLength(2);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(2);
    await expect(readEffectLog(effectLogPath)).rejects.toMatchObject({ code: "E_SCHEMA_PARSE" });

    const tapeRecords = await readTape(tapePath);
    const tapeEvents = tapeRecords.filter((record): record is TapeEventRecord => record.type === "event").map((record) => record.event);
    expect(tapeEvents).toEqual(result.events);
    expect((await verifyTape(tapePath)).ok).toBe(true);
  });

  it("serializes mutating tools and lets exclusive tools block surrounding work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sched-exclusive-"));
    const target = join(dir, "target.txt");
    await writeFile(target, "v0\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    const executionLog: string[] = [];
    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient([
        { type: "message_start", schemaVersion: 1 },
        { type: "tool_use", schemaVersion: 1, id: "w1", name: "write_file", input: { path: target, content: "v1\n" } },
        { type: "tool_use", schemaVersion: 1, id: "x1", name: "bash", input: { command: "echo hi" } },
        { type: "tool_use", schemaVersion: 1, id: "w2", name: "write_file", input: { path: target, content: "v2\n" } },
        { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
      ]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      concurrency: new ConcurrencyClassifier([
        { name: "write_file", class: "serial" },
        { name: "bash", class: "exclusive" },
      ]),
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          executionLog.push(input.content.trim());
          await new Promise((resolve) => setTimeout(resolve, 5));
          await writeFile(input.path, input.content, "utf8");
          return { output: `wrote ${input.content.trim()}`, paths: [input.path] };
        },
        bash: async () => {
          executionLog.push("bash");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { output: "ok", paths: [] };
        },
      },
    });

    expect(executionLog).toEqual(["v1", "bash", "v2"]);
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0].toolCallId).toBe("w1");
    expect(result.effects[1].toolCallId).toBe("w2");
    expect(result.decisions).toHaveLength(3);
    expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
    expect((await verifyTape(tapePath)).ok).toBe(true);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(3);
  });
});
