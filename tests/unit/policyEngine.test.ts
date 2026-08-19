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

  it("does not let pathPrefix leak onto sibling paths sharing leading characters", () => {
    const prefixDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "deny",
      rules: [
        { id: "allow-tests-write", action: "approve", match: { tool: "write_file", pathPrefix: "tests" } },
      ],
    };
    const prefixEngine = new PolicyEngine(prefixDoc);
    const decide = (path: string) => prefixEngine.decide({
      toolCallId: "p",
      toolName: "write_file",
      mode: "assist",
      input: { path, content: "x" },
      at: "2026-04-09T00:00:00Z",
    }).result;

    expect(decide("tests/math.test.ts")).toBe("approve");
    expect(decide("tests")).toBe("approve");
    expect(decide("tests-evil/math.test.ts")).toBe("deny");
    expect(decide("tests.bak")).toBe("deny");
  });

  it("normalizes paths so aliasing and traversal cannot dodge rules", () => {
    const aliasDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "ask",
      rules: [
        { id: "deny-secrets", action: "deny", match: { pathPrefix: "secrets" } },
        { id: "allow-tests-write", action: "approve", match: { tool: "write_file", pathPrefix: "tests" } },
        { id: "allow-exact", action: "approve", match: { tool: "read_file", path: "docs/README.md" } },
      ],
    };
    const aliasEngine = new PolicyEngine(aliasDoc);
    const decide = (toolName: string, path: string) => aliasEngine.decide({
      toolCallId: "n",
      toolName,
      mode: "assist",
      input: { path, content: "x" },
      at: "2026-04-09T00:00:00Z",
    }).result;

    // Aliased spellings of a denied location still hit the deny rule.
    expect(decide("write_file", "./secrets/key.pem")).toBe("deny");
    expect(decide("write_file", "secrets//key.pem")).toBe("deny");
    expect(decide("write_file", "tests/../secrets/key.pem")).toBe("deny");
    // Traversal cannot ride an approve prefix out of its subtree.
    expect(decide("write_file", "tests/../src/index.ts")).toBe("ask");
    expect(decide("write_file", "../tests/math.test.ts")).toBe("ask");
    // Aliased spellings still match exact-path and prefix approve rules.
    expect(decide("read_file", "./docs/README.md")).toBe("approve");
    expect(decide("write_file", "tests/./math.test.ts")).toBe("approve");
  });

  it("scopes approve rules to every path in a multi-path call", () => {
    const multiDoc: PolicyDoc = {
      schemaVersion: 1,
      defaultAction: "deny",
      rules: [
        { id: "allow-tests-write", action: "approve", match: { tool: "write_file", pathPrefix: "tests" } },
        { id: "deny-secrets", action: "deny", match: { pathPrefix: "secrets" } },
      ],
    };
    const multiEngine = new PolicyEngine(multiDoc);
    const decide = (paths: string[]) => multiEngine.decide({
      toolCallId: "m",
      toolName: "write_file",
      mode: "assist",
      input: { paths },
      at: "2026-04-09T00:00:00Z",
    });

    // Every path in scope: the approve rule still wins.
    expect(decide(["tests/a.ts", "tests/b.ts"]).result).toBe("approve");
    // One path outside the approve rule's subtree must not be granted by it;
    // the call falls through to the default deny instead.
    const smuggled = decide(["tests/a.ts", "/etc/shadow"]);
    expect(smuggled.result).toBe("deny");
    expect(smuggled.winningRuleId).toBeNull();
    // Deny rules keep "any path matches" semantics.
    const denied = decide(["tests/a.ts", "secrets/key.pem"]);
    expect(denied.result).toBe("deny");
    expect(denied.winningRuleId).toBe("deny-secrets");
  });

  it("never matches a path-scoped rule against a call with no paths", () => {
    const d = eng.decide({
      toolCallId: "np",
      toolName: "write_file",
      mode: "assist",
      input: { content: "no path here" },
      at: "2026-04-09T00:00:00Z",
    });
    expect(d.result).toBe("deny");
    expect(d.winningRuleId).toBeNull();
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

  it("wraps malformed policy JSON in a schema-parse harness error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sig3-"));
    const p = join(dir, "policy.json");
    await writeFile(p, "{ not json");
    await expect(loadPolicy(p, { strict: false })).rejects.toThrow(/not valid JSON/);
  });
});
