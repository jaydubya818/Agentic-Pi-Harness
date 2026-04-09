import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { ModelClient } from "../../src/adapter/pi-adapter.js";
import { StreamEvent } from "../../src/schemas/index.js";
import { readPolicyLog } from "../../src/policy/decision.js";

function transientError(code: string): Error & { code: string } {
  const error = new Error(`transient ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

class FailBeforeFirstEventOnceModel implements ModelClient {
  name = "fail-before-first-event-once";
  invocationCount = 0;

  constructor(private readonly script: StreamEvent[], private readonly code: string) {}

  stream(): AsyncIterable<StreamEvent> {
    this.invocationCount += 1;
    const invocation = this.invocationCount;
    let index = 0;
    const script = this.script;
    const code = this.code;

    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next() {
            if (invocation === 1 && index === 0) {
              throw transientError(code);
            }
            if (index >= script.length) return { done: true, value: undefined as never };
            return { done: false, value: script[index++] };
          },
        };
      },
    };
  }
}

class AlwaysFailBeforeFirstEventModel implements ModelClient {
  name = "always-fail-before-first-event";
  invocationCount = 0;

  constructor(private readonly code: string) {}

  stream(): AsyncIterable<StreamEvent> {
    this.invocationCount += 1;
    const code = this.code;
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next() {
            throw transientError(code);
          },
        };
      },
    };
  }
}

class MidStreamFailOnceModel implements ModelClient {
  name = "mid-stream-fail-once";
  invocationCount = 0;

  constructor(private readonly script: StreamEvent[], private readonly failAfterEvents: number, private readonly code: string) {}

  stream(): AsyncIterable<StreamEvent> {
    this.invocationCount += 1;
    let index = 0;
    let thrown = false;
    const script = this.script;
    const failAfterEvents = this.failAfterEvents;
    const code = this.code;

    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next() {
            if (index === failAfterEvents && !thrown) {
              thrown = true;
              throw transientError(code);
            }
            if (index >= script.length) return { done: true, value: undefined as never };
            return { done: false, value: script[index++] };
          },
        };
      },
    };
  }
}

function writeToolScript(target: string): StreamEvent[] {
  return [
    { type: "message_start", schemaVersion: 1 },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "write_file", input: { path: target, content: "patched\n" } },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];
}

describe("query loop retry", () => {
  it("retries transient model-open failures when retry config is present without duplicating tape, policy, or effect records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-open-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const model = new FailBeforeFirstEventOnceModel(writeToolScript(target), "ECONNRESET");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    const result = await runQueryLoop({
      sessionId: "s",
      model,
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });

    expect(model.invocationCount).toBe(2);
    expect(result.events.map((event) => event.type)).toEqual([
      "message_start",
      "tool_use",
      "tool_result",
      "message_stop",
    ]);
    expect(result.decisions).toHaveLength(1);
    expect(result.effects).toHaveLength(1);
    expect(result.counters["retry.attempted"]).toBe(1);
    expect(result.counters["retry.succeeded"]).toBe(1);
    expect(await readFile(target, "utf8")).toBe("patched\n");

    const tapeVerification = await verifyTape(tapePath);
    expect(tapeVerification.ok).toBe(true);
    expect(tapeVerification.records).toBe(5);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(1);
    expect(await readEffectLog(effectLogPath)).toHaveLength(1);
  });

  it("fails closed when retry budget is exhausted before any event is persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-exhausted-"));
    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    const model = new AlwaysFailBeforeFirstEventModel("ECONNRESET");
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    await expect(runQueryLoop({
      sessionId: "s",
      model,
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      tools: {},
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
    })).rejects.toMatchObject({
      code: "E_MODEL_ADAPTER",
      context: {
        retryClassification: "model_open_transient",
        attempt: 2,
        maxAttempts: 2,
        boundaryReason: "before_first_persisted_event",
      },
    });

    expect(model.invocationCount).toBe(2);
    const tapeVerification = await verifyTape(tapePath);
    expect(tapeVerification.ok).toBe(true);
    expect(tapeVerification.records).toBe(1);
  });

  it("does not retry when the stream fails after an event has already been persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-midstream-"));
    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    const model = new MidStreamFailOnceModel([
      { type: "message_start", schemaVersion: 1 },
      { type: "text_delta", schemaVersion: 1, text: "hello" },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ], 1, "ECONNRESET");
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    await expect(runQueryLoop({
      sessionId: "s",
      model,
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      tools: {},
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    })).rejects.toMatchObject({
      code: "E_MODEL_ADAPTER",
      context: {
        retryClassification: "model_midstream_after_persist",
        attempt: 1,
        maxAttempts: 3,
        boundaryReason: "after_persisted_event",
      },
    });

    expect(model.invocationCount).toBe(1);
    const tapeVerification = await verifyTape(tapePath);
    expect(tapeVerification.ok).toBe(true);
    expect(tapeVerification.records).toBe(2);
  });

  it("does not retry model invocation failures by default when retry config is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-disabled-"));
    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    const model = new AlwaysFailBeforeFirstEventModel("ECONNRESET");
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    await expect(runQueryLoop({
      sessionId: "s",
      model,
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      tools: {},
    })).rejects.toMatchObject({
      code: "E_MODEL_ADAPTER",
      context: {
        retryClassification: "model_open_transient",
        attempt: 1,
        maxAttempts: 1,
        boundaryReason: "before_first_persisted_event",
      },
    });

    expect(model.invocationCount).toBe(1);
  });

  it("keeps tool failures outside retry scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-tool-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    const model = new FailBeforeFirstEventOnceModel(writeToolScript(target), "ECONNRESET");
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    let toolCalls = 0;
    const result = await runQueryLoop({
      sessionId: "s",
      model,
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      tools: {
        write_file: async () => {
          toolCalls += 1;
          throw new Error("disk full");
        },
      },
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });

    expect(model.invocationCount).toBe(2);
    expect(toolCalls).toBe(1);
    expect(result.events.at(-2)).toMatchObject({ type: "tool_result", isError: true });
    await expect(readEffectLog(join(dir, "effects.jsonl"))).rejects.toMatchObject({ code: "E_SCHEMA_PARSE" });
  });
});
