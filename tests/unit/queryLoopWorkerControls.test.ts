import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { readPolicyLog } from "../../src/policy/decision.js";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { ConcurrencyClassifier } from "../../src/tools/concurrency.js";

describe("query loop worker controls", () => {
  it("denies worker-mode writes outside allowed prefixes without producing effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-worker-ctrl-"));
    const target = join(dir, "blocked.txt");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-10T00:00:00.000Z" });

    const result = await runQueryLoop({
      sessionId: "s1",
      mode: "worker",
      model: new MockModelClient([
        { type: "message_start", schemaVersion: 1 },
        { type: "tool_use", schemaVersion: 1, id: "t1", name: "write_file", input: { path: target, content: "patched\n" } },
        { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
      ]),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      workerControls: { signedPolicy: true, allowedWritePathPrefixes: ["sandbox/"] },
      concurrency: new ConcurrencyClassifier([{ name: "write_file", class: "serial" }]),
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].result).toBe("deny");
    expect(result.decisions[0].manifestInfluence).toEqual({ field: "workerControl", value: "writePathPrefix" });
    expect(result.effects).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect((await verifyTape(tapePath)).ok).toBe(true);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(1);
    await expect(readEffectLog(effectLogPath)).rejects.toMatchObject({ code: "E_SCHEMA_PARSE" });
  });
});
