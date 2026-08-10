import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { Counters, FanOutCounters } from "../../src/metrics/counter.js";
import { CostTable } from "../../src/metrics/cost.js";

const table: CostTable = {
  version: "test",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputPer1k: 3.0,
  outputPer1k: 15.0,
};

async function runScriptedLoop(dir: string, inputs: { counters?: FanOutCounters; costTable?: CostTable }) {
  const tape = new ReplayRecorder(join(dir, "tape.jsonl"));
  await tape.writeHeader({
    sessionId: "session-metrics",
    loopGitSha: "dev",
    policyDigest: "sha256:policy-test",
    costTableVersion: "test",
  });
  try {
    return await runQueryLoop({
      sessionId: "session-metrics",
      model: new MockModelClient([
        { type: "message_start", schemaVersion: 1 },
        { type: "text_delta", schemaVersion: 1, text: "working on it" },
        { type: "tool_use", schemaVersion: 1, id: "t1", name: "echo", input: {} },
        { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
      ]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      policyDigest: "sha256:policy-test",
      tools: {
        echo: async () => ({ output: "12345678", paths: [] }),
      },
      ...inputs,
    });
  } finally {
    await tape.close();
  }
}

describe("query loop metrics wiring", () => {
  it("increments a caller-provided counters sink in real time and snapshots it into LoopResult", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-metrics-"));
    const local = new Counters();
    const mirror = new Counters();
    const sink = new FanOutCounters([local, mirror]);

    const result = await runScriptedLoop(dir, { counters: sink });

    // Both fan-out targets saw the increments (the otel.ts usage contract).
    expect(local.snapshot()["events.tool_use"]).toBe(1);
    expect(mirror.snapshot()["events.tool_use"]).toBe(1);
    expect(local.snapshot()["policy.approve"]).toBe(1);
    // And the LoopResult snapshot comes from the same sink.
    expect(result.counters["events.tool_use"]).toBe(1);
    expect(result.counters["events.message_stop"]).toBe(1);
  });

  it("defaults to an internal in-memory sink when none is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-metrics-"));
    const result = await runScriptedLoop(dir, {});
    expect(result.counters["events.tool_use"]).toBe(1);
    expect(result.cost).toBeNull();
  });

  it("produces a cost record from the event stream when a cost table is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-metrics-"));
    const result = await runScriptedLoop(dir, { costTable: table });

    expect(result.cost).not.toBeNull();
    expect(result.cost?.provider).toBe("anthropic");
    expect(result.cost?.model).toBe("claude-sonnet-4-6");
    // "working on it" (13 chars -> 4 tokens) as output; the wrapped tool
    // result body counts as input-next-turn.
    expect(result.cost?.outputTokens).toBeGreaterThan(0);
    expect(result.cost?.inputTokens).toBeGreaterThan(0);
    expect(result.cost?.usd).toBeGreaterThan(0);
  });
});
