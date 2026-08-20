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
const noisy = query.includes("__NOISY__");
const megaline = query.includes("__MEGALINE__");
const decoySession = query.includes("__DECOY_SESSION__");

/**
 * Flush stdout/stderr before exiting.
 *
 * `process.exit()` abandons anything still queued on a pipe, so a worker that
 * has just streamed a large backlog can lose its own result block. That is
 * exactly the tail the adapter parses, so exiting without flushing makes the
 * adapter tests fail intermittently under load.
 */
function exitAfterFlush(code) {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

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
  exitAfterFlush(code);
}

process.on("SIGINT", async () => {
  await finish(130, "interrupted by test signal");
});

process.on("SIGTERM", async () => {
  await finish(143, "cancelled by test signal");
});

(async () => {
  if (decoySession) {
    console.log("session_id: decoy-mid-output");
    console.log("prefix session_id: decoy-trailing-text more words");
    await finish(0, null);
    return;
  }

  if (fail) {
    await finish(3, "fake hermes failure");
    return;
  }

  if (megaline) {
    // One giant line with no newline until the very end: exercises the
    // adapter's partial-line retention cap.
    const filler = "m".repeat(8192);
    for (let i = 0; i < 40; i++) process.stdout.write(filler);
    process.stdout.write("\n");
    await finish(0, null);
    return;
  }

  if (noisy) {
    const filler = "noisy fake hermes filler line 0123456789".repeat(4);
    for (let i = 0; i < 1000; i++) console.log(`${i} ${filler}`);
    await finish(0, null);
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
