import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExternalTarget } from "../../src/cli/validate-target.js";

describe("external target validation", () => {
  it("keeps artifacts harness-local and lets Sofie summarize bounded validation", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "pi-external-validation-"));
    const result = await validateExternalTarget("../../AI_CEO", outRoot, async (command) => ({
      stdout: `${command} ok`,
      stderr: "",
      ok: command !== "npm run lint",
    }));

    expect(result.artifactsLocal).toBe(true);
    expect(result.targetRepoName).toBe("AI_CEO");
    const summary = JSON.parse(await readFile(join(result.outDir, "summary.json"), "utf8")) as { commands: Array<{ command: string; ok: boolean }> };
    expect(summary.commands).toHaveLength(3);
  });
});
