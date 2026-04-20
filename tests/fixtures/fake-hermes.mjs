#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const query = argValue("-q") || argValue("--query") || "";
const resume = argValue("--resume");
const sessionId = resume || "fake-hermes-session";
const outputDirMatch = query.match(/- Output dir for artifacts: (.+)/);
const outputDir = outputDirMatch ? outputDirMatch[1].trim() : null;
const slow = query.includes("__SLOW__");
const fail = query.includes("__FAIL__");

async function finish(code = 0, error = null) {
  let artifacts = [];
  if (outputDir && !error) {
    const reportPath = `${outputDir}/report.md`;
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, "# Fake Hermes Report\n\nEverything looks good.\n", "utf8");
    artifacts = [{ type: "report", path: reportPath }];
  }

  if (error) {
    console.log(error);
  } else {
    console.log("fake hermes worker output");
  }
  console.log("contract example (not the real result):");
  console.log("<<PI_TASK_RESULT_JSON");
  console.log(JSON.stringify({ summary: "example only", artifacts: [], error: null }));
  console.log("PI_TASK_RESULT_JSON>>");
  console.log("real result follows:");
  console.log("<<PI_TASK_RESULT_JSON");
  console.log(JSON.stringify({
    summary: error ? error : "Fake Hermes completed successfully",
    artifacts,
    error,
  }));
  console.log("PI_TASK_RESULT_JSON>>");
  console.error(`session_id: ${sessionId}`);
  process.exit(code);
}

process.on("SIGINT", async () => {
  await finish(130, "interrupted by test signal");
});

process.on("SIGTERM", async () => {
  await finish(143, "cancelled by test signal");
});

(async () => {
  if (fail) {
    await finish(3, "fake hermes failure");
    return;
  }

  if (slow) {
    console.log("starting slow fake task");
    setInterval(() => {
      console.log("still working");
    }, 250);
    return;
  }

  await finish(0, null);
})();
