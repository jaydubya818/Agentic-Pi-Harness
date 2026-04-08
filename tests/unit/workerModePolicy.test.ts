import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, signPolicy } from "../../src/policy/signed.js";
import { PolicyDoc } from "../../src/policy/engine.js";

const doc: PolicyDoc = {
  schemaVersion: 1,
  default: "ask",
  rules: [{ id: "r", match: { tool: "*" }, action: "approve" }],
};

describe("worker mode signed-policy refusal", () => {
  it("refuses a policy with no signature file at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wm-"));
    const p = join(dir, "policy.json");
    await writeFile(p, JSON.stringify(doc));
    const key = Buffer.from("k".repeat(32));
    await expect(loadPolicy(p, { key, strict: true })).rejects.toThrow(/unsigned|signature/);
  });

  it("refuses a signature signed with the wrong key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wm2-"));
    const p = join(dir, "policy.json");
    await writeFile(p, JSON.stringify(doc));
    const goodKey = Buffer.from("k".repeat(32));
    const wrongKey = Buffer.from("x".repeat(32));
    await writeFile(p + ".sig", signPolicy(doc, wrongKey));
    await expect(loadPolicy(p, { key: goodKey, strict: true })).rejects.toThrow(/signature/);
  });

  it("refuses a malformed signature file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wm3-"));
    const p = join(dir, "policy.json");
    await writeFile(p, JSON.stringify(doc));
    await writeFile(p + ".sig", "not-a-real-sig");
    const key = Buffer.from("k".repeat(32));
    await expect(loadPolicy(p, { key, strict: true })).rejects.toThrow(/malformed|signature/);
  });

  it("lax mode tolerates missing signature but flags signed:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wm4-"));
    const p = join(dir, "policy.json");
    await writeFile(p, JSON.stringify(doc));
    const loaded = await loadPolicy(p, { key: Buffer.from("k".repeat(32)), strict: false });
    expect(loaded.signed).toBe(false);
    expect(loaded.digest).toMatch(/^sha256:/);
  });
});
