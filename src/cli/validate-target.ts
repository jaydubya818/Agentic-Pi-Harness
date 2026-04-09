import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { answerRoutineQuestion } from "../sofie/authority.js";

export interface ExternalValidationResult {
  targetRepoName: string;
  targetPath: string;
  outDir: string;
  artifactsLocal: true;
  commands: Array<{ command: string; ok: boolean; stdout: string; stderr: string }>;
  sofieSummary: string;
}

export async function validateExternalTarget(targetPath: string, outRoot: string, exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string; ok: boolean }>): Promise<ExternalValidationResult> {
  const resolvedTarget = resolve(targetPath);
  const targetRepoName = basename(resolvedTarget);
  const outDir = join(resolve(outRoot), "external-validation", targetRepoName);
  await mkdir(outDir, { recursive: true });

  const commandsToRun = ["npm install", "npm run lint", "npm run build"];
  const commands: ExternalValidationResult["commands"] = [];
  for (const command of commandsToRun) {
    const result = await exec(command, join(resolvedTarget, "web"));
    commands.push({ command, ok: result.ok, stdout: result.stdout, stderr: result.stderr });
  }

  const sofie = answerRoutineQuestion({
    sessionId: `external-${targetRepoName}`,
    mode: "assist",
    question: `Review bounded validation status for ${targetRepoName}`,
    kind: "review",
    targetRepo: {
      name: targetRepoName,
      path: resolvedTarget,
      validationCommands: commandsToRun,
    },
    targetSummary: {
      installOk: commands[0]?.ok,
      lintOk: commands[1]?.ok,
      buildOk: commands[2]?.ok,
      notes: commands.filter((entry) => !entry.ok).map((entry) => `${entry.command} failed`),
    },
    frictionFindings: commands.filter((entry) => !entry.ok).map((entry) => entry.stderr || entry.stdout).filter(Boolean),
  });

  await writeFile(join(outDir, "summary.json"), JSON.stringify({ targetRepoName, commands, sofie }, null, 2));

  return {
    targetRepoName,
    targetPath: resolvedTarget,
    outDir,
    artifactsLocal: true,
    commands,
    sofieSummary: sofie.summary,
  };
}
