import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertValidStateTransition,
  buildLegacyObjectiveFromV2,
  computeArtifactManifestItem,
  deriveArtifactRoot,
  isTerminalV2State,
  PiHermesRunState,
  PiHermesRunStateSchema,
  PiHermesTaskEnvelopeV2,
  PiHermesTaskEnvelopeV2Schema,
  writeJsonArtifact,
} from "../../src/hermes/contractV2.js";

const createdPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "contract-v2-helpers-"));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function task(artifacts: Array<{ path: string; required?: boolean }>): PiHermesTaskEnvelopeV2 {
  return PiHermesTaskEnvelopeV2Schema.parse({
    schema_version: "2.0",
    request_id: "req-1",
    run_id: "run-1",
    mission_id: "m-1",
    session_id: "s-1",
    execution_id: "e-1",
    task_type: "summarize",
    goal: "Write the summary",
    instructions: ["Read the input", "Write the output"],
    constraints: { network_access: false, write_access: true },
    workdir: "/tmp/work",
    timeout_seconds: 60,
    artifacts_expected: artifacts.map((artifact, index) => ({
      type: "file",
      role: index === 0 ? "primary" : `extra-${index}`,
      path: artifact.path,
      required: artifact.required ?? true,
    })),
    approval_policy: { mode: "auto", allow_interrupt: true, allow_cancel: true },
    priority: "normal",
  });
}

describe("Contract V2 run-state table", () => {
  const states = PiHermesRunStateSchema.options;
  const terminal: PiHermesRunState[] = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];

  function successors(from: PiHermesRunState): PiHermesRunState[] {
    return states.filter((to) => {
      try {
        assertValidStateTransition(from, to);
        return true;
      } catch {
        return false;
      }
    });
  }

  it("isTerminalV2State agrees with the transition table: terminal states have no exits, others do", () => {
    for (const state of states) {
      const exits = successors(state);
      expect(isTerminalV2State(state), state).toBe(terminal.includes(state));
      expect(exits.length === 0, `${state} exits: ${exits.join(",")}`).toBe(isTerminalV2State(state));
    }
  });

  it("pins the full allowed-transition table", () => {
    const table = Object.fromEntries(states.map((state) => [state, successors(state)]));
    expect(table).toEqual({
      queued: ["accepted", "cancelled"],
      accepted: ["starting", "failed", "cancelled"],
      starting: ["running", "failed", "cancelled", "timed_out"],
      running: ["waiting_approval", "blocked", "producing_artifacts", "failed", "cancelled", "interrupted", "timed_out"],
      waiting_approval: ["running", "failed", "cancelled", "timed_out"],
      blocked: ["running", "failed", "cancelled", "timed_out"],
      producing_artifacts: ["succeeded", "failed", "cancelled", "timed_out"],
      succeeded: [],
      failed: [],
      cancelled: [],
      interrupted: [],
      timed_out: [],
    });
  });

  it("never allows a self-transition or a step backwards past accepted", () => {
    for (const state of states) {
      expect(() => assertValidStateTransition(state, state)).toThrow(/invalid state transition/);
      if (state !== "queued") {
        expect(() => assertValidStateTransition(state, "queued")).toThrow(/invalid state transition/);
      }
    }
    expect(() => assertValidStateTransition("running", "succeeded")).toThrow("invalid state transition: running -> succeeded");
  });
});

describe("deriveArtifactRoot", () => {
  it("returns the shared parent directory of every expected artifact", () => {
    expect(deriveArtifactRoot(task([{ path: "/out/a/report.md" }, { path: "/out/a/trace.json" }]))).toBe(resolve("/out/a"));
  });

  it("rejects artifacts that do not share one parent directory, including nested ones", () => {
    expect(() => deriveArtifactRoot(task([{ path: "/out/a/report.md" }, { path: "/out/b/report.md" }])))
      .toThrow(/single artifact root/);
    expect(() => deriveArtifactRoot(task([{ path: "/out/a/report.md" }, { path: "/out/a/sub/trace.json" }])))
      .toThrow(/single artifact root/);
  });

  it("counts optional artifacts toward the root check", () => {
    expect(() => deriveArtifactRoot(task([{ path: "/out/a/report.md" }, { path: "/out/b/opt.md", required: false }])))
      .toThrow(/single artifact root/);
  });
});

describe("buildLegacyObjectiveFromV2", () => {
  it("renders numbered instructions and one line per expected artifact", () => {
    const objective = buildLegacyObjectiveFromV2(task([{ path: "/out/a/report.md" }, { path: "/out/a/opt.md", required: false }]));
    expect(objective.split("\n")).toEqual([
      "Task type: summarize",
      "Goal: Write the summary",
      "Instructions:",
      "1. Read the input",
      "2. Write the output",
      "Expected artifacts:",
      "- file/primary: /out/a/report.md required=true",
      "- file/extra-1: /out/a/opt.md required=false",
      "Return the required structured result block only.",
    ]);
  });
});

describe("computeArtifactManifestItem", () => {
  it("hashes and sizes the same bytes and infers the mime type from the extension", async () => {
    const dir = await makeTempDir();
    const content = Buffer.from("héllo\n", "utf8");
    const cases: Array<[string, string | null]> = [
      ["a.md", "text/markdown"],
      ["a.json", "application/json"],
      ["a.log", "text/plain"],
      ["a.patch", "text/x-diff"],
      ["a.diff", "text/x-diff"],
      ["a.txt", null],
      ["Makefile", null],
    ];
    for (const [name, mime] of cases) {
      const path = join(dir, name);
      await writeFile(path, content);
      const item = await computeArtifactManifestItem({ artifactId: "art-1", type: "file", role: "primary", path, producedBy: "pi" });
      expect(item.mime_type, name).toBe(mime);
      expect(item.sha256).toBe(`sha256:${createHash("sha256").update(content).digest("hex")}`);
      // Byte length, not character length.
      expect(item.size_bytes).toBe(7);
      expect(item.path).toBe(resolve(path));
      expect(() => new Date(item.created_at).toISOString()).not.toThrow();
      expect(item.description).toBeUndefined();
    }
  });

  it("carries the description through and rejects a missing file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "present.json");
    await writeFile(path, "{}");
    const item = await computeArtifactManifestItem({
      artifactId: "art-1", type: "file", role: "primary", path, producedBy: "pi", description: "the thing",
    });
    expect(item.description).toBe("the thing");
    await expect(computeArtifactManifestItem({
      artifactId: "art-2", type: "file", role: "primary", path: join(dir, "absent.json"), producedBy: "pi",
    })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeJsonArtifact", () => {
  it("writes pretty-printed JSON that reads back equal", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "result.json");
    const value = { schema_version: "2.0", nested: { list: [1, 2] } };
    await writeJsonArtifact(path, value);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(value);
    expect(raw).toContain("\n");
  });
});
