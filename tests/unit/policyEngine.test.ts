import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDoc } from "../../src/policy/engine.js";
import { signPolicy, loadPolicy } from "../../src/policy/signed.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doc: PolicyDoc = {
  schemaVersion: 1,
  defaultAction: "deny",
  rules: [
    { id: "allow-read", action: "approve", match: { tool: "read_file" } },
    { id: "allow-tests-write", action: "approve", match: { tool: "write_file", pathPrefix: "tests/" } },
    { id: "deny-plan-write", action: "deny", match: { tool: "write_file", mode: "plan" } },
  ],
};

describe("PolicyEngine", () => {
  const eng = new PolicyEngine(doc);

  it("approves reads with real provenance", () => {
    const d = eng.decide({
      toolCallId: "a",
      toolName: "read_file",
      mode: "assist",
      input: { path: "tests/math.test.ts" },
      at: "2026-04-09T00:00:00Z",
    });
    expect(d.result).toBe("approve");
    expect(d.winningRuleId).toBe("allow-read");
    expect(d.provenanceMode).toBe("real");
    expect(d.evaluationOrder).toEqual(["allow-read", "allow-tests-write", "deny-plan-write"]);
  });

  it("approves writes under tests/ via pathPrefix match", () => {
    const d = eng.decide({
      toolCallId: "b",
      toolName: "write_file",
      mode: "assist",
      input: { path: "tests/math.test.ts", content: "patched" },
      at: "2026-04-09T00:00:00Z",
    });
    expect(d.result).toBe("approve");
    expect(d.winningRuleId).toBe("allow-tests-write");
  });

  it("falls through to explicit default deny", () => {
    const d = eng.decide({
      toolCallId: "c",
      toolName: "stat_file",
      mode: "assist",
      input: { path: "tests/math.test.ts" },
      at: "2026-04-09T00:00:00Z",
    });
    expect(d.result).toBe("deny");
    expect(d.winningRuleId).toBeNull();
  });

  it("matches mode exactly with first-match-wins order", () => {
    const d = eng.decide({
      toolCallId: "d",
      toolName: "write_file",
      mode: "plan",
      input: { path: "tests/math.test.ts", content: "patched" },
      at: "2026-04-09T00:00:00Z",
    });
    expect(d.result).toBe("approve");
    expect(d.winningRuleId).toBe("allow-tests-write");
  });
});

describe("signed policy", () => {
  it("round-trips HMAC signature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sig-"));
    const p = join(dir, "policy.json");
    await writeFile(p, JSON.stringify(doc));
    const key = Buffer.from("k".repeat(32));
    const sig = signPolicy(doc, key);
    await writeFile(p + ".sig", sig);
    const loaded = await loadPolicy(p, { key, strict: true });
    expect(loaded.signed).toBe(true);
    expect(loaded.digest).toMatch(/^sha256:/);
  });

  it("rejects tampered policy in strict mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sig2-"));
    const p = join(dir, "policy.json");
    const key = Buffer.from("k".repeat(32));
    await writeFile(p, JSON.stringify(doc));
    await writeFile(p + ".sig", signPolicy(doc, key));
    const tampered: PolicyDoc = { ...doc, defaultAction: "approve" };
    await writeFile(p, JSON.stringify(tampered));
    await expect(loadPolicy(p, { key, strict: true })).rejects.toThrow(/signature/);
  });
});
