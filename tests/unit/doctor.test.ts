import { describe, it, expect } from "vitest";
import { doctor } from "../../src/cli/doctor.js";

/**
 * `doctor` reads fixed paths relative to process.cwd() — .tool-versions,
 * package.json, goldens/canonical/tape.jsonl. Vitest runs with cwd at the
 * repo root (see vitest.config.ts), so these paths resolve to the real repo
 * files and doctor() exercises its happy-path checks end-to-end.
 */
describe("cli: doctor", () => {
  it("returns a structured list of checks that all pass on a healthy repo", async () => {
    const checks = await doctor();

    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(4);

    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

    expect(byName["node >= 20"]?.ok).toBe(true);
    expect(byName["node >= 20"]?.detail).toMatch(/^\d+\.\d+\.\d+/);

    expect(byName[".tool-versions present"]?.ok).toBe(true);
    expect(byName["zod installed"]?.ok).toBe(true);

    const golden = byName["canonical golden tape verifies"];
    expect(golden?.ok).toBe(true);
    // On a healthy repo, the detail is the committed digest.
    expect(golden?.detail).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("every check has the expected shape", async () => {
    const checks = await doctor();
    for (const c of checks) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.ok).toBe("boolean");
      if (c.detail !== undefined) expect(typeof c.detail).toBe("string");
    }
  });
});
