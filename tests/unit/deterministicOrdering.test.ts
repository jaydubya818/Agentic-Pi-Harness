import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCodeUnits } from "../../src/schemas/canonical.js";
import { EffectRecorder } from "../../src/effect/recorder.js";
import { __adapterTestables } from "../../src/hermes/adapter.js";

// U+00AD SOFT HYPHEN is ignorable at primary strength under ICU collation, so
// "re­port.md".localeCompare("report.md") === 0 even though the two names
// are distinct. Array#sort is stable, so an equal-comparing pair keeps its
// input order -- which is readdir order, i.e. exactly the nondeterminism the
// sorts in these modules exist to remove.
const SOFT_HYPHEN_NAME = "re­port.md";
const PLAIN_NAME = "report.md";

describe("compareCodeUnits", () => {
  it("is a total order over strings ICU collation reports as equal", () => {
    expect(SOFT_HYPHEN_NAME.localeCompare(PLAIN_NAME)).toBe(0);
    expect(compareCodeUnits(SOFT_HYPHEN_NAME, PLAIN_NAME)).not.toBe(0);
    expect(
      Math.sign(compareCodeUnits(SOFT_HYPHEN_NAME, PLAIN_NAME)),
    ).toBe(-Math.sign(compareCodeUnits(PLAIN_NAME, SOFT_HYPHEN_NAME)));
  });

  it("orders by code unit rather than by collation strength", () => {
    // "Z" (U+005A) precedes "a" (U+0061) by code unit; ICU puts "alpha" first.
    expect(compareCodeUnits("Zeta.md", "alpha.md")).toBeLessThan(0);
    expect("Zeta.md".localeCompare("alpha.md")).toBeGreaterThan(0);
  });

  it("agrees with the default Array#sort comparator", () => {
    const input = ["b", "A", "a", "Z", "_x", "1"];
    expect([...input].sort(compareCodeUnits)).toEqual([...input].sort());
  });
});

describe("effect record path ordering", () => {
  it("uses code unit order, not collation order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-order-effect-"));
    const upper = join(dir, "Zeta.md");
    const lower = join(dir, "alpha.md");
    await writeFile(upper, "x\n");
    await writeFile(lower, "y\n");

    const recorder = new EffectRecorder();
    await recorder.snapshotPre([lower, upper], "t1");
    const record = await recorder.capturePost("s1", "t1", "write_file", [lower, upper]);

    expect(record.paths).toEqual([upper, lower]);
  });

  it("does not depend on the order the paths arrive in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-order-effect-ign-"));
    const soft = join(dir, SOFT_HYPHEN_NAME);
    const plain = join(dir, PLAIN_NAME);
    await writeFile(soft, "x\n");
    await writeFile(plain, "y\n");

    const forward = new EffectRecorder();
    await forward.snapshotPre([soft, plain], "t1");
    const a = await forward.capturePost("s1", "t1", "write_file", [soft, plain]);

    const reversed = new EffectRecorder();
    await reversed.snapshotPre([plain, soft], "t2");
    const b = await reversed.capturePost("s1", "t2", "write_file", [plain, soft]);

    expect(a.paths).toEqual(b.paths);
    expect(a.paths).toEqual([plain, soft]);
  });
});

describe("artifact scan ordering", () => {
  it("uses code unit order, not collation order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-order-art-"));
    await writeFile(join(dir, "Zeta.md"), "x\n");
    await writeFile(join(dir, "alpha.md"), "y\n");

    const artifacts = await __adapterTestables.detectArtifacts(dir);
    expect(artifacts.map((a) => a.path.split("/").pop())).toEqual(["Zeta.md", "alpha.md"]);
  });

  it("orders names that ICU collation cannot distinguish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-order-art-ign-"));
    await writeFile(join(dir, SOFT_HYPHEN_NAME), "x\n");
    await writeFile(join(dir, PLAIN_NAME), "y\n");

    const artifacts = await __adapterTestables.detectArtifacts(dir);
    const names = artifacts.map((a) => a.path.split("/").pop()!);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual([PLAIN_NAME, SOFT_HYPHEN_NAME]);
  });
});
