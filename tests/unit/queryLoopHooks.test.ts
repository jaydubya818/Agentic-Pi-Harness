import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { EffectRecorder, readEffectLog } from "../../src/effect/recorder.js";
import { RegisteredToolHook } from "../../src/hooks/mediation.js";
import { runQueryLoop } from "../../src/loop/query.js";
import { PolicyEngine, PolicyDoc } from "../../src/policy/engine.js";
import { readPolicyLog } from "../../src/policy/decision.js";
import { ReplayRecorder, verifyTape } from "../../src/replay/recorder.js";
import { StreamEvent } from "../../src/schemas/index.js";

function script(target: string): StreamEvent[] {
  return [
    { type: "message_start", schemaVersion: 1 },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "write_file", input: { path: target, content: "patched\n" } },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];
}

describe("query loop hook mediation", () => {
  it("pre-hook deny persists hookDecision, emits deny-style tool_result, and skips effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hook-loop-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-09T00:00:00.000Z" });

    const policyDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "approve",
      rules: [{ id: "allow-write", action: "approve", match: { tool: "write_file" } }],
    };
    const hooks: RegisteredToolHook[] = [
      { hookId: "block-write", event: "PreToolUse", timeoutMs: 100, fn: () => ({ outcome: "deny", reason: "review-required" }) },
    ];

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script(target)),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      policy: new PolicyEngine(policyDoc),
      policyMode: "real",
      policyDigest: "sha256:policy",
      hooks,
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].result).toBe("deny");
    expect(result.decisions[0].winningRuleId).toBe("allow-write");
    expect(result.decisions[0].hookDecision).toEqual({ hookId: "block-write", decision: "deny", reason: "review-required" });
    expect(result.effects).toHaveLength(0);
    expect(result.compactedEvents).toEqual(result.events);
    expect(result.compactions).toEqual([]);
    expect(result.approvalPackets).toEqual([]);
    expect(result.approvalDecisions).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect(result.events.at(-2)).toMatchObject({ type: "tool_result", isError: true });
    expect((result.events.at(-2) as Extract<StreamEvent, { type: "tool_result" }>).output).toContain("hook block-write");
    expect((await verifyTape(tapePath)).ok).toBe(true);
    expect(await readPolicyLog(policyLogPath)).toHaveLength(1);
    await expect(readEffectLog(effectLogPath)).rejects.toMatchObject({ code: "E_SCHEMA_PARSE" });
  });

  it("post hooks are observe-only and invalid post outcomes do not change persisted artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hook-post-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tapePath = join(dir, "tape.jsonl");
    const effectLogPath = join(dir, "effects.jsonl");
    const policyLogPath = join(dir, "policy.jsonl");
    const tape = new ReplayRecorder(tapePath);
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-09T00:00:00.000Z" });

    const policyDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "deny",
      rules: [{ id: "allow-write", action: "approve", match: { tool: "write_file" } }],
    };
    const hooks: RegisteredToolHook[] = [
      { hookId: "deny-post", event: "PostToolUse", timeoutMs: 100, fn: () => ({ outcome: "deny", reason: "too-late" }) },
    ];

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script(target)),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath,
      policyLogPath,
      policy: new PolicyEngine(policyDoc),
      policyMode: "real",
      policyDigest: "sha256:policy",
      hooks,
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].result).toBe("approve");
    expect(result.decisions[0].hookDecision).toBeNull();
    expect(result.effects).toHaveLength(1);
    expect(result.compactedEvents).toEqual(result.events);
    expect(result.compactions).toEqual([]);
    expect(result.approvalPackets).toEqual([]);
    expect(result.approvalDecisions).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("patched\n");
    expect((await verifyTape(tapePath)).ok).toBe(true);
    const policyLog = await readPolicyLog(policyLogPath);
    expect(policyLog[0].hookDecision).toBeNull();
  });

  it("counts hook runs by phase and outcome so a gate that never answered is distinguishable from one that allowed the call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hook-evidence-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");
    const policyLogPath = join(dir, "policy.jsonl");

    const tape = new ReplayRecorder(join(dir, "tape.jsonl"));
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-09T00:00:00.000Z" });

    const policyDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "approve",
      rules: [{ id: "allow-write", action: "approve", match: { tool: "write_file" } }],
    };
    // Three gates that do not answer: one throws, one returns a malformed
    // response, one allows. The failures are deliberately fail-open (see
    // docs/HOOK-SECURITY.md item 7) -- the point of this case is that the
    // failure is now *recorded*, not that it blocks.
    const hooks: RegisteredToolHook[] = [
      { hookId: "crashing-gate", event: "PreToolUse", timeoutMs: 100, fn: () => { throw new Error("gate crashed"); } },
      { hookId: "malformed-gate", event: "PreToolUse", timeoutMs: 100, fn: () => ({ nonsense: true }) },
      { hookId: "allowing-gate", event: "PreToolUse", timeoutMs: 100, fn: () => ({ outcome: "continue" as const }) },
      { hookId: "crashing-observer", event: "PostToolUse", timeoutMs: 100, fn: () => { throw new Error("observer crashed"); } },
    ];

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script(target)),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath,
      policy: new PolicyEngine(policyDoc),
      policyMode: "real",
      policyDigest: "sha256:policy",
      hooks,
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    // Fail-open is unchanged: the call still went through.
    expect(await readFile(target, "utf8")).toBe("patched\n");
    expect(result.decisions[0].result).toBe("approve");
    expect(result.decisions[0].hookDecision).toBeNull();

    // ...but the persisted metrics now say two pre-gates did not answer,
    // which is what makes this session distinguishable from a clean one.
    // Pre-fix, every one of these keys was absent.
    expect(result.counters["hook.pre.error"]).toBe(1);
    expect(result.counters["hook.pre.invalid"]).toBe(1);
    expect(result.counters["hook.pre.continue"]).toBe(1);
    expect(result.counters["hook.post.error"]).toBe(1);
  });

  it("emits no hook.* counters at all when the session configures no hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hook-none-"));
    const target = join(dir, "math.test.ts");
    await writeFile(target, "original\n", "utf8");

    const tape = new ReplayRecorder(join(dir, "tape.jsonl"));
    await tape.writeHeader({ sessionId: "s1", loopGitSha: "dev", policyDigest: "sha256:policy", costTableVersion: "2026-04-01", createdAt: "2026-04-09T00:00:00.000Z" });

    const result = await runQueryLoop({
      sessionId: "s1",
      model: new MockModelClient(script(target)),
      tape,
      effects: new EffectRecorder(),
      checkpointPath: join(dir, "checkpoint.json"),
      effectLogPath: join(dir, "effects.jsonl"),
      policyLogPath: join(dir, "policy.jsonl"),
      policy: new PolicyEngine({ schemaVersion: 1, defaultAction: "approve", rules: [] }),
      policyMode: "real",
      policyDigest: "sha256:policy",
      tools: {
        write_file: async (input: { path: string; content: string }) => {
          await writeFile(input.path, input.content, "utf8");
          return { output: "wrote", paths: [input.path] };
        },
      },
    });

    // This is what keeps the change additive: no hooks configured means no
    // new counter keys, so metrics.json bytes and the canonical golden
    // digest are untouched for every existing run.
    expect(Object.keys(result.counters).filter((key) => key.startsWith("hook."))).toEqual([]);
  });
});
