import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeStateIdSegment, HermesBridgeStateStore } from "../../src/hermes/bridgeState.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HermesBridgeStateStore", () => {
  it("skips corrupt preflight denial lines instead of dropping the whole log", async () => {
    const root = await makeTempDir("pi-bridge-state-denials-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    await store.appendPreflightDenial({ at: "2026-07-23T00:00:00Z", code: "one", message: "first" });
    await appendFile(join(root, "preflight-denials.jsonl"), '{"torn":', "utf8");
    await appendFile(join(root, "preflight-denials.jsonl"), "\n", "utf8");
    await store.appendPreflightDenial({ at: "2026-07-23T00:00:01Z", code: "two", message: "second" });

    const denials = await store.loadPreflightDenials();
    expect(denials.map((denial) => denial.code)).toEqual(["one", "two"]);
  });

  it("refuses execution and session ids that are not safe path segments", async () => {
    for (const bad of ["../escape", "a/b", "a\\b", ".", "..", "a\0b", ""]) {
      expect(() => assertSafeStateIdSegment(bad, "execution_id")).toThrow(/not a safe path segment/);
    }
    expect(assertSafeStateIdSegment("exec_abc123", "execution_id")).toBe("exec_abc123");

    const root = await makeTempDir("pi-bridge-state-unsafe-");
    const store = new HermesBridgeStateStore(root);
    await store.init();
    await expect(store.appendRunEvent("../escaped", {
      type: "task.progress",
      session_id: "sess_x",
      execution_id: "../escaped",
      at: "2026-07-23T00:00:00Z",
      data: {},
    })).rejects.toThrow(/not a safe path segment/);
  });
});
