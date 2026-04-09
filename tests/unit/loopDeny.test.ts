import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { PolicyEngine, PolicyDoc } from "../../src/policy/engine.js";
import { ConcurrencyClassifier } from "../../src/tools/concurrency.js";
import { verifyTape } from "../../src/cli/verify.js";
import { StreamEvent } from "../../src/schemas/index.js";

describe("loop integration: deny path + tape still verifies", () => {
  it("denies forbidden read, allows allowed write, tape chain intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
    const work = join(dir, "work");
    await writeFile(join(dir, "dummy"), ""); // ensure dir

    const target = join(dir, "ok.ts");
    await writeFile(target, "old\n");

    const script: StreamEvent[] = [
      { type: "message_start", schemaVersion: 1 },
      { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: "/etc/shadow" } },
      { type: "tool_use", schemaVersion: 1, id: "t2", name: "write_file", input: { path: target, content: "new\n" } },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ];

    const policyDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "approve",
      rules: [
        { id: "deny-secrets", action: "deny", match: { tool: "read_file", pathPrefix: "/etc/" } },
      ],
    };

    const tapePath = join(dir, "tape.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "t", policyDigest: "sha256:x", costTableVersion: "v1" });

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "cp.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      policy: new PolicyEngine(policyDoc),
      policyMode: "real",
      mode: "assist",
      concurrency: new ConcurrencyClassifier([
        { name: "read_file", class: "readonly" },
        { name: "write_file", class: "serial" },
      ]),
      tools: {
        read_file: async (i: { path: string }) => ({ output: await readFile(i.path, "utf8"), paths: [i.path] }),
        write_file: async (i: { path: string; content: string }) => {
          await writeFile(i.path, i.content);
          return { output: "wrote", paths: [i.path] };
        },
      },
    });

    // Decisions: deny for t1, approve for t2
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].result).toBe("deny");
    expect(result.decisions[0].winningRuleId).toBe("deny-secrets");
    expect(result.decisions[1].result).toBe("approve");
    expect(result.compactedEvents).toEqual(result.events);
    expect(result.compactions).toEqual([]);

    // Effects: only the approved write produced one
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].toolName).toBe("write_file");

    // Tape still verifies end-to-end
    const v = await verifyTape(tapePath);
    expect(v.ok).toBe(true);

    // Write actually happened
    expect(await readFile(target, "utf8")).toBe("new\n");

    // Counters reflect deny + approve
    expect(result.counters["policy.deny"]).toBe(1);
    expect(result.counters["policy.approve"]).toBe(1);
  });
});
