import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../../src/schemas/canonical.js";

describe("frozen canonical artifacts", () => {
  it("canonical golden files remain byte-stable", async () => {
    const base = join(process.cwd(), "goldens", "canonical");
    const tape = await readFile(join(base, "tape.jsonl"), "utf8");
    const effects = await readFile(join(base, "effects.jsonl"), "utf8");
    const policy = await readFile(join(base, "policy.jsonl"), "utf8");

    expect(sha256Hex(tape)).toBe("5538a61c40b673584edf790d25657574d484258478df906fe4469d1c8ed4d054");
    expect(sha256Hex(effects)).toBe("8ebd66a7fc5c95a010014d9c41bcf6d9f2efcd99fbf4aa8ef40f66d421df7fd0");
    expect(sha256Hex(policy)).toBe("21171e8a3bfb8b069ab7dd8993522e6723da822c75c1d057d0715fafbfeb21b3");
  });
});
