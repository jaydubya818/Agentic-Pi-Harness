import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvenanceManifest,
  readProvenance,
  writeSessionStartProvenance,
} from "../../src/session/provenance.js";
import { PiHarnessError } from "../../src/errors.js";

describe("provenance", () => {
  it("creates a versioned manifest with deterministic fields", () => {
    const manifest = createProvenanceManifest({
      sessionId: "session-1",
      loopGitSha: "abc123",
      repoGitSha: null,
      provider: "mock",
      model: "mock-1",
      costTableVersion: "2026-04-01",
      piMdDigest: null,
      policyDigest: "sha256:policy",
      createdAt: "2026-04-08T00:00:00.000Z",
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      sessionId: "session-1",
      loopGitSha: "abc123",
      repoGitSha: null,
      provider: "mock",
      model: "mock-1",
      costTableVersion: "2026-04-01",
      piMdDigest: null,
      policyDigest: "sha256:policy",
      createdAt: "2026-04-08T00:00:00.000Z",
    });
  });

  it("writes provenance atomically and validates it on read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-provenance-"));
    const path = join(dir, "provenance.json");

    const written = await writeSessionStartProvenance(path, {
      sessionId: "session-1",
      loopGitSha: "abc123",
      repoGitSha: null,
      provider: "mock",
      model: "mock-1",
      costTableVersion: "2026-04-01",
      piMdDigest: null,
      policyDigest: "sha256:policy",
      createdAt: "2026-04-08T00:00:00.000Z",
    });

    const entries = await readdir(dir);
    expect(entries).toContain("provenance.json");
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const readBack = await readProvenance(path);
    expect(readBack).toEqual(written);
  });

  it("fails closed when reading schema-invalid provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-provenance-invalid-"));
    const path = join(dir, "provenance.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, sessionId: "missing-fields" }));

    await expect(readProvenance(path)).rejects.toMatchObject<PiHarnessError>({
      name: "PiHarnessError",
      code: "E_SCHEMA_PARSE",
    });
  });
});
