import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoldenPathMockModelClient } from "../../src/adapter/pi-adapter.js";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { readPolicyLog } from "../../src/policy/decision.js";

describe("query loop", () => {
  it("runs the canonical golden path end to end at Tier A scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-query-"));
    const workdir = join(dir, "work");
    const target = join(workdir, "tests", "math.test.ts");
    await mkdir(join(workdir, "tests"), { recursive: true });
    await writeFile(target, "test('adds', () => { expect(1 + 1).toBe(3); });\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const checkpointPath = join(dir, "checkpoint.json");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({
      sessionId: "session-1",
      loopGitSha: "dev",
      policyDigest: "sha256:policy-test",
      costTableVersion: "2026-04-01",
      createdAt: "2026-04-08T00:00:00.000Z",
    });

    const result = await runQueryLoop({
      sessionId: "session-1",
      model: createGoldenPathMockModelClient({ targetPath: target }),
      tape,
      effects: new EffectRecorder(),
      checkpointPath,
      effectLogPath,
      policyLogPath,
      policyDigest: "sha256:policy-test",
      tools: {
        read_file: async (input: { path: string }) => ({
          output: await readFile(input.path, "utf8"),
          paths: [input.path],
        }),
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: `wrote ${input.path}`, paths: [input.path] };
        },
      },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "message_start",
      "text_delta",
      "tool_use",
      "tool_result",
      "text_delta",
      "tool_use",
      "tool_result",
      "message_stop",
    ]);
    expect(result.effects).toHaveLength(1);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((decision) => decision.provenanceMode === "placeholder")).toBe(true);

    const tapeVerification = await verifyTape(tapePath);
    expect(tapeVerification.ok).toBe(true);

    const effectLog = await readEffectLog(effectLogPath);
    expect(effectLog).toHaveLength(1);
    expect(effectLog[0].toolName).toBe("write_file");

    const policyLog = await readPolicyLog(policyLogPath);
    expect(policyLog).toHaveLength(2);
    expect(policyLog[0].policyDigest).toBe("sha256:policy-test");

    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(checkpoint.stopReason).toBe("end_turn");

    expect(await readFile(target, "utf8")).toBe("test('adds', () => { expect(1 + 1).toBe(2); });\n");
  });
});
