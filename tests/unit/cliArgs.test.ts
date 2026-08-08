import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertKnownFlag, isCliEntrypoint, parseIntFlag } from "../../src/cli/args.js";

describe("parseIntFlag", () => {
  it("accepts plain decimal integers within range", () => {
    expect(parseIntFlag("--port", "8787", { min: 0, max: 65535 })).toBe(8787);
    expect(parseIntFlag("--timeout", "1", { min: 1, max: 86400 })).toBe(1);
    expect(parseIntFlag("--timeout", " 42 ", { min: 1, max: 86400 })).toBe(42);
    expect(parseIntFlag("--offset", "+5", { min: 0, max: 10 })).toBe(5);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseIntFlag("--port", "65536", { min: 0, max: 65535 })).toThrow(/invalid --port/);
    expect(() => parseIntFlag("--timeout", "0", { min: 1, max: 86400 })).toThrow(/invalid --timeout/);
  });

  it("rejects non-numeric and non-decimal spellings the error message does not promise", () => {
    for (const raw of ["abc", "", "  ", "0x10", "1e3", "5.0", "1_000", "Infinity", "NaN"]) {
      expect(() => parseIntFlag("--timeout", raw, { min: 0, max: 86400 })).toThrow(/expected an integer/);
    }
  });
});

describe("assertKnownFlag", () => {
  it("ignores non-flag arguments", () => {
    expect(() => assertKnownFlag("positional", ["--port"])).not.toThrow();
  });

  it("reports a known flag missing its value", () => {
    expect(() => assertKnownFlag("--port", ["--port"])).toThrow(/--port requires a value/);
  });

  it("reports unknown flags with the known list", () => {
    expect(() => assertKnownFlag("--objectve", ["--objective"])).toThrow(/unknown flag: --objectve/);
  });
});

describe("isCliEntrypoint", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "pi-cli entry-"));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("matches the historical exact spelling", () => {
    expect(isCliEntrypoint("file:///repo/dist/cli/kb.js", "/repo/dist/cli/kb.js")).toBe(true);
  });

  it("matches when the path contains URL-escaped characters (space in clone path)", async () => {
    const entry = join(scratch, "entry.mjs");
    await writeFile(entry, "export {};\n");
    const metaUrl = pathToFileURL(realpathSync(entry)).href;
    expect(metaUrl).toContain("%20"); // the scratch dir name embeds a space
    expect(metaUrl === `file://${entry}`).toBe(false); // historical guard fails
    expect(isCliEntrypoint(metaUrl, entry)).toBe(true);
  });

  it("matches when argv[1] is a symlink to the real module (npm .bin stub)", async () => {
    const real = join(scratch, "real.mjs");
    const link = join(scratch, "stub-link.mjs");
    await writeFile(real, "export {};\n");
    await symlink(real, link);
    const metaUrl = pathToFileURL(realpathSync(real)).href;
    expect(metaUrl === `file://${link}`).toBe(false); // historical guard fails
    expect(isCliEntrypoint(metaUrl, link)).toBe(true);
  });

  it("is false for a different module, a missing argv path, or an unresolvable path", async () => {
    const entry = join(scratch, "other.mjs");
    await writeFile(entry, "export {};\n");
    expect(isCliEntrypoint(pathToFileURL(entry).href, join(scratch, "entry.mjs"))).toBe(false);
    expect(isCliEntrypoint(pathToFileURL(entry).href, undefined)).toBe(false);
    expect(isCliEntrypoint(pathToFileURL(entry).href, join(scratch, "does-not-exist.mjs"))).toBe(false);
  });
});
