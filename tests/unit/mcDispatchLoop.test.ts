import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McSeqStore, toMcBridgeState } from "../../src/mc/dispatchLoop.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("McSeqStore — persisted monotonically increasing seq", () => {
  it("issues 1, 2, 3 within one instance", async () => {
    const dir = await makeTempDir("mc-seq-");
    const store = new McSeqStore(join(dir, "mc-dispatch-seq.json"));
    expect(await store.next("wo1", "run1")).toBe(1);
    expect(await store.next("wo1", "run1")).toBe(2);
    expect(await store.next("wo1", "run1")).toBe(3);
  });

  it("resumes from the persisted seq after restart (never reuses a seq)", async () => {
    const dir = await makeTempDir("mc-seq-");
    const path = join(dir, "mc-dispatch-seq.json");

    const first = new McSeqStore(path);
    await first.next("wo1", "run1");
    await first.next("wo1", "run1");
    await first.next("wo1", "run1");

    // Simulated restart: a fresh store instance reading the same state file.
    const second = new McSeqStore(path);
    expect(await second.next("wo1", "run1")).toBe(4);
    expect(await second.next("wo1", "run1")).toBe(5);
  });

  it("tracks seq independently per (workOrder, bridgeRun) pair", async () => {
    const dir = await makeTempDir("mc-seq-");
    const store = new McSeqStore(join(dir, "mc-dispatch-seq.json"));
    expect(await store.next("wo1", "run1")).toBe(1);
    expect(await store.next("wo1", "run2")).toBe(1);
    expect(await store.next("wo2", "run1")).toBe(1);
    expect(await store.next("wo1", "run1")).toBe(2);
  });

  it("persists valid JSON usable as a state-file fake", async () => {
    const dir = await makeTempDir("mc-seq-");
    const path = join(dir, "mc-dispatch-seq.json");
    const store = new McSeqStore(path);
    await store.next("wo1", "run1");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.seqs["wo1:run1"]).toBe(1);
  });

  it("recovers from a corrupt state file by starting fresh", async () => {
    const dir = await makeTempDir("mc-seq-");
    const path = join(dir, "mc-dispatch-seq.json");
    await writeFile(path, "not json", "utf8");
    const store = new McSeqStore(path);
    expect(await store.next("wo1", "run1")).toBe(1);
  });
});

describe("toMcBridgeState — bridge run normalization", () => {
  it("passes through contract-v2 states that MC models", () => {
    for (const state of ["accepted", "starting", "running", "producing_artifacts", "succeeded", "failed", "timed_out", "interrupted", "cancelled"]) {
      expect(toMcBridgeState({ status: "running", state, error: null })).toBe(state);
    }
  });

  it("returns null for states MC does not model", () => {
    expect(toMcBridgeState({ status: "running", state: "queued", error: null })).toBeNull();
    expect(toMcBridgeState({ status: "running", state: "waiting_approval", error: null })).toBeNull();
    expect(toMcBridgeState({ status: "running", state: "blocked", error: null })).toBeNull();
  });

  it("maps legacy statuses onto the MC contract", () => {
    expect(toMcBridgeState({ status: "accepted", error: null })).toBe("accepted");
    expect(toMcBridgeState({ status: "running", error: null })).toBe("running");
    expect(toMcBridgeState({ status: "completed", error: null })).toBe("succeeded");
    expect(toMcBridgeState({ status: "failed", error: "boom" })).toBe("failed");
    expect(toMcBridgeState({ status: "cancelled", error: null })).toBe("cancelled");
    expect(toMcBridgeState({ status: "interrupted", error: null })).toBe("interrupted");
  });

  it("distinguishes timeout failures from plain failures via the error message", () => {
    expect(toMcBridgeState({ status: "failed", error: "Timed out after 900 seconds" })).toBe("timed_out");
    expect(toMcBridgeState({ status: "failed", error: "exit code 1" })).toBe("failed");
  });
});
