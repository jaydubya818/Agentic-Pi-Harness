import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { ConcurrencyClassifier } from "../../src/tools/concurrency.js";
import { StreamEvent } from "../../src/schemas/index.js";

/**
 * Two write_file calls targeting the same path in one batch. Because
 * write_file is classified `serial`, they run one after another. Each call
 * must see the correct pre-state: the first call's pre = original, the
 * second call's pre = first call's post. The per-call EffectScope makes
 * this true; a shared EffectRecorder.pre map would have clobbered it.
 */
describe("loop: per-call EffectScope isolates same-path concurrent writes", () => {
  it("two serial writes to the same path each see the correct pre-state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cw-"));
    const target = join(dir, "f.txt");
    await writeFile(target, "v0\n");

    const script: StreamEvent[] = [
      { type: "message_start", schemaVersion: 1 },
      { type: "tool_use", schemaVersion: 1, id: "w1", name: "write_file", input: { path: target, content: "v1\n" } },
      { type: "tool_use", schemaVersion: 1, id: "w2", name: "write_file", input: { path: target, content: "v2\n" } },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ];

    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s", loopGitSha: "g", policyDigest: "sha256:0", costTableVersion: "v1" });

    const result = await runQueryLoop({
      sessionId: "s",
      model: new MockModelClient(script),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "cp.json"),
      effectLogPath: join(dir, "e.jsonl"),
      policyLogPath: join(dir, "p.jsonl"),
      concurrency: new ConcurrencyClassifier([{ name: "write_file", class: "serial" }]),
      tools: {
        write_file: async (i: { path: string; content: string }) => {
          await writeFile(i.path, i.content);
          return { output: "ok", paths: [i.path] };
        },
      },
    });

    expect(result.effects).toHaveLength(2);
    const [r1, r2] = result.effects;

    // First call: pre = original "v0\n"
    const v0hash = r1.preHashes[target];
    const v1hash = r1.postHashes[target];
    // Second call: pre MUST equal first call's post (not the original)
    expect(r2.preHashes[target]).toBe(v1hash);
    expect(r2.preHashes[target]).not.toBe(v0hash);

    // Final file is v2
    expect(await readFile(target, "utf8")).toBe("v2\n");
  });
});
