#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const query = argValue("-q") || argValue("--query") || "";
const resume = argValue("--resume");
const sessionId = resume || "fake-hermes-contract-v2-session";

const markers = {
  missingArtifact: query.includes("__MISSING_ARTIFACT__"),
  malformed: query.includes("__MALFORMED_RESULT__"),
  stuck: query.includes("__STUCK__"),
};

function extractExpectedArtifacts(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = line.match(/- ([^/]+)\/([^:]+): (.+) required=(true|false)$/);
      if (!match) return null;
      return {
        type: match[1],
        role: match[2],
        path: match[3],
        required: match[4] === "true",
      };
    })
    .filter(Boolean);
}

function frontmatter(path, id, missionId = "mission-test", runId = "run-test") {
  return [
    "---",
    `id: ${id}`,
    "trust: staged",
    "created_by: hermes",
    "created_at: 2026-04-20T00:00:00Z",
    `mission_id: ${missionId}`,
    `run_id: ${runId}`,
    "source_paths:",
    `  - ${path}`,
    "status: candidate",
    "---",
    "",
  ].join("\n");
}

async function maybeWriteSummary(artifacts) {
  const summary = artifacts.find((artifact) => artifact.type === "summary");
  if (!summary || markers.missingArtifact) return;
  await mkdir(dirname(summary.path), { recursive: true });
  await writeFile(summary.path, `${frontmatter(summary.path, "summary-artifact")}# Golden Mission Summary\n\nHermes completed the golden mission summary artifact.\n`, "utf8");
}

async function maybeWriteDiscovery(artifacts) {
  const discovery = artifacts.find((artifact) => artifact.type === "discovery");
  if (!discovery) return;
  await mkdir(dirname(discovery.path), { recursive: true });
  await writeFile(discovery.path, `${frontmatter(discovery.path, "discovery-artifact")}# Discovery Candidate\n\nA useful candidate was discovered during the governed mission.\n`, "utf8");
}

async function finish() {
  const artifacts = extractExpectedArtifacts(query);
  await maybeWriteSummary(artifacts);
  await maybeWriteDiscovery(artifacts);

  if (markers.malformed) {
    console.log("<<PI_TASK_RESULT_JSON");
    console.log('{"summary":"broken"');
    console.log("PI_TASK_RESULT_JSON>>");
    console.error(`session_id: ${sessionId}`);
    process.exit(0);
  }

  console.log("worker progress");
  console.log("<<PI_TASK_RESULT_JSON");
  console.log(JSON.stringify({
    summary: markers.missingArtifact
      ? "Hermes intentionally omitted the summary artifact."
      : "Hermes completed the golden mission worker step.",
    artifacts: [],
    error: null,
  }));
  console.log("PI_TASK_RESULT_JSON>>");
  console.error(`session_id: ${sessionId}`);
  process.exit(0);
}

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

(async () => {
  if (markers.stuck) {
    setInterval(() => {}, 1000);
    return;
  }
  await finish();
})();
