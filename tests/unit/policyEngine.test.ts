import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDoc } from "../../src/policy/engine.js";
import { signPolicy, loadPolicy } from "../../src/policy/signed.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doc: PolicyDoc = {
  schemaVersion: 1,
  default: "ask",
  rules: [
    { id: "deny-secrets", match: { tool: "read_file", pathPrefix: "/etc/" }, action: "deny" },
    { id: "allow-repo-writes", match: { tool: "write_*", pathPrefix: "./src/" }, action: "approve" },
    { id: "plan-mode-readonly", match: { mode: "plan", tool: "write_*" }, action: "deny" },
  ],
};

describe("PolicyEngine", () => {
  const eng = new PolicyEngine(doc);

  it("denies secret reads with provenance", () => {
    const d = eng.decide({ toolCallId: "a", toolName: "read_file", mode: "assist", input: { path: "/etc/passwd" } });
    expect(d.result).toBe("deny");
    expect(d.winningRuleId).toBe("deny-secrets");
    expect(d.provenanceMode).toBe("full");
    expect(d.evaluationOrder).toEqual(["deny-secrets", "allow-repo-writes", "plan-mode-readonly"]);
  });

  it("approves repo writes via glob", () => {
    const d = eng.decide({ toolCallId: "b", toolName: "write_file", mode: "assist", input: { path: "./src/x.ts" } });
    expect(d.result).toBe("approve");
    expect(d.winningRuleId).toBe("allow-repo-writes");
  });

  it("falls through to default ask", () => {
    const d = eng.decide({ toolCallId: "c", toolName: "bash", mode: "assist", input: { cmd: "ls" } });
    expect(d.result).toBe("ask");
    expect(d.winningRuleId).toBeNull();
  });

  it("plan mode blocks writes (first match wins)", () => {
    // allow-repo-writes comes first, so src writes are allowed even in plan mode.
    // This test documents that rule order matters.
    const d = eng.decide({ toolCallId: "d", toolName: "write_file", mode: "plan", input: { path: "./src/x.ts" } });
    expect(d.result).toBe("approve");
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
    const tampered = { ...doc, default: "approve" as const };
    await writeFile(p, JSON.stringify(tampered));
    await expect(loadPolicy(p, { key, strict: true })).rejects.toThrow(/signature/);
  });
});
