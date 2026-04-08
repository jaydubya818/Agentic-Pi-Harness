import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { verifyTape } from "../../src/cli/verify.js";
import { ModelClient } from "../../src/adapter/pi-adapter.js";
import { StreamEvent } from "../../src/schemas/index.js";

/**
 * Flaky model: the first `failAt` yields succeed, the next throws a transient
 * error once, then the rest succeed. Proves that withRetry around iter.next()
 * resumes the stream without re-emitting prior chunks.
 */
class FlakyModel implements ModelClient {
  name = "flaky";
  constructor(private script: StreamEvent[], private failAt: number) {}
  stream(): AsyncIterable<StreamEvent> {
    let i = 0;
    let thrown = false;
    const script = this.script;
    const failAt = this.failAt;
    const it: AsyncIterator<StreamEvent> = {
      async next() {
        if (i === failAt && !thrown) {
          thrown = true;
          throw new Error("ECONNRESET");
        }
        if (i >= script.length) return { done: true, value: undefined as any };
        return { done: false, value: script[i++] };
      },
    };
    return { [Symbol.asyncIterator]: () => it };
  }
}

describe("loop retry: no tape duplication on mid-stream failure", () => {
  it("resumes after transient error without re-writing prior events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-retry-"));
    const script: StreamEvent[] = [
      { type: "message_start", schemaVersion: 1 },
      { type: "text_delta", schemaVersion: 1, text: "one" },
      { type: "text_delta", schemaVersion: 1, text: "two" },   // failAt = 2 → throws here, first time
      { type: "text_delta", schemaVersion: 1, text: "three" },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ];

    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    const result = await runQueryLoop({
      sessionId: "s",
      model: new FlakyModel(script, 2),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "cp.json"),
      effectLogPath: join(dir, "e.jsonl"),
      policyLogPath: join(dir, "p.jsonl"),
      tools: {},
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });

    // Exactly 5 events reached the tape — no duplicates.
    expect(result.events).toHaveLength(5);
    const texts = result.events.filter((e) => e.type === "text_delta").map((e: any) => e.text);
    expect(texts).toEqual(["one", "two", "three"]);

    // Tape still hash-chains end to end.
    const v = await verifyTape(tapePath);
    expect(v.ok).toBe(true);
    expect(v.records).toBe(6); // header + 5 events
  });
});
