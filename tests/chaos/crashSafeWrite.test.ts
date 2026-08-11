import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWriteJson } from "../../src/session/provenance.js";

describe("chaos: crash-safe write leaves no partial file", () => {
  it("write-rename produces only the final file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-safe-"));
    const target = join(dir, "checkpoint.json");
    await safeWriteJson(target, { schemaVersion: 1, a: 1 });
    const entries = await readdir(dir);
    expect(entries).toContain("checkpoint.json");
    expect(entries.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(parsed.a).toBe(1);
  });

  it("survives concurrent writers to the same path without tearing or throwing", async () => {
    // Regression: with a fixed `path + ".tmp"` tmp name, concurrent writers
    // truncated each other's tmp mid-fsync and the losers' renames threw
    // ENOENT once the winner moved the shared tmp away.
    const dir = await mkdtemp(join(tmpdir(), "pi-safe3-"));
    const target = join(dir, "run.json");
    const attempts = Array.from({ length: 8 }, (_, index) =>
      safeWriteJson(target, { schemaVersion: 1, attempt: index, payload: "x".repeat(4096) }),
    );
    await Promise.all(attempts);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(typeof parsed.attempt).toBe("number");
    expect(parsed.payload.length).toBe(4096);
    const entries = await readdir(dir);
    expect(entries.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("overwrites atomically without leaving .tmp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-safe2-"));
    const target = join(dir, "cp.json");
    await writeFile(target, '{"old":true}');
    await safeWriteJson(target, { schemaVersion: 1, new: true });
    const entries = await readdir(dir);
    expect(entries.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(target, "utf8")).new).toBe(true);
  });
});
