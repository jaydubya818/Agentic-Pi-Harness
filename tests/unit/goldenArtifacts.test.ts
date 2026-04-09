import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { verifyTape } from "../../src/replay/recorder.js";
import { replayTape } from "../../src/cli/replay.js";
import { readEffectLog } from "../../src/effect/recorder.js";
import { readPolicyLog } from "../../src/policy/decision.js";

const GOLDEN_DIR = join(process.cwd(), "goldens", "canonical");

describe("golden artifacts", () => {
  it("ships a replayable canonical tape", async () => {
    const tapePath = join(GOLDEN_DIR, "tape.jsonl");
    const verification = await verifyTape(tapePath);
    expect(verification.ok).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await replayTape(tapePath)).toBe(0);
      expect(errSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.at(-1)?.[0]).toContain("ok 9 records digest=");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("ships canonical Level B/C sidecar logs", async () => {
    const effects = await readEffectLog(join(GOLDEN_DIR, "effects.jsonl"));
    const decisions = await readPolicyLog(join(GOLDEN_DIR, "policy.jsonl"));

    expect(effects).toHaveLength(1);
    expect(effects[0].toolName).toBe("write_file");
    expect(decisions).toHaveLength(2);
    expect(decisions.every((decision) => decision.provenanceMode === "placeholder")).toBe(true);
  });
});
