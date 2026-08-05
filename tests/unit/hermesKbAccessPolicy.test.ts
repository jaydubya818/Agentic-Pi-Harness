import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesBridgeServer } from "../../src/hermes/httpBridge.js";
import {
  assertRequiredFrontmatter,
  classifyKnowledgePath,
  createKnowledgeTombstone,
  deleteKnowledgePath,
  ensureKnowledgeDirectorySkeleton,
  ensureMissionRunSkeleton,
  hasFrontmatter,
  promoteKnowledgeCandidate,
  writeKnowledgeJson,
  writeKnowledgeText,
} from "../../src/hermes/kbAccessPolicy.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).reverse().map((path) => rm(path, { recursive: true, force: true })));
});

describe("KB access policy V1", () => {
  it("create-mode writes are exclusive even when the existence check raced", async () => {
    const kbRoot = await makeTempDir("pi-kb-exclusive-");
    const wikiRoot = await makeTempDir("pi-wiki-exclusive-");
    const roots = { agenticKbRoot: kbRoot, llmWikiRoot: wikiRoot };
    const queueItem = join(kbRoot, "queues/discovery/item-1.json");

    // Simulate a racing writer landing the file after the caller decided on
    // create mode but before the write hits the filesystem: an explicit
    // create-mode write against an existing file must not clobber it.
    await writeKnowledgeJson({ actor: "hermes", path: queueItem, value: { first: true }, roots });
    await expect(
      writeKnowledgeJson({ actor: "hermes", path: queueItem, value: { second: true }, mode: "create", roots }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(queueItem, "utf8"))).toEqual({ first: true });

    // Same guarantee at the filesystem layer (O_EXCL), where the policy layer
    // would otherwise allow pi to overwrite: create means create.
    const piNote = join(kbRoot, "staging/normalized/note.json");
    await writeKnowledgeJson({ actor: "pi", path: piNote, value: { first: true }, mode: "create", roots });
    await expect(
      writeKnowledgeJson({ actor: "pi", path: piNote, value: { second: true }, mode: "create", roots }),
    ).rejects.toThrow(/EEXIST/);
    expect(JSON.parse(await readFile(piNote, "utf8"))).toEqual({ first: true });
  });

  it("denies the JSON writer as a frontmatter bypass for governed markdown artifacts", async () => {
    const roots = await createRoots();
    const events: string[] = [];
    const path = join(roots.agenticKbRoot, "staging/normalized/note.md");
    await expect(writeKnowledgeJson({
      actor: "pi",
      path,
      value: { sneaky: true },
      roots,
      onEvent: (event) => { events.push(event.type); },
    })).rejects.toThrow(/must be written via writeKnowledgeText/);
    expect(events).toContain("kb.frontmatter_validation_failed");
  });

  it("allows Hermes writes in approved mission output zones", async () => {
    const roots = await createRoots();
    const runRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-alpha", "runs", "run-1");
    await ensureMissionRunSkeleton({ missionRoot: runRoot });
    const target = join(runRoot, "outputs", "summary.md");

    await writeKnowledgeText({
      actor: "hermes",
      path: target,
      roots,
      content: validFrontmatter("mission-alpha", "run-1") + "# Summary\n\nAllowed output.\n",
    });

    await expect(access(target)).resolves.toBeUndefined();
  });

  it("blocks Hermes queue mutation in place", async () => {
    const roots = await createRoots();
    const target = join(roots.agenticKbRoot, "queues", "discovery", "candidate.md");
    await writeKnowledgeText({ actor: "hermes", path: target, roots, content: validFrontmatter("mission-alpha", "run-1") + "# Candidate\n" });
    await expect(writeKnowledgeText({ actor: "hermes", path: target, roots, content: validFrontmatter("mission-alpha", "run-1") + "# Updated\n" })).rejects.toThrow(/create-only/);
  });

  it("emits kb.queue_create for JSON queue creates", async () => {
    const roots = await createRoots();
    const target = join(roots.agenticKbRoot, "queues", "discovery", "candidate.json");
    const events: string[] = [];

    await writeKnowledgeJson({
      actor: "hermes",
      path: target,
      roots,
      value: { candidate: true },
      onEvent: (event) => { events.push(event.type); },
    });

    expect(events).toEqual(["kb.queue_create"]);
  });

  it("blocks Hermes writes into canonical KB paths", async () => {
    const roots = await createRoots();
    const target = join(roots.agenticKbRoot, "knowledge", "promoted", "forbidden.md");

    await expect(writeKnowledgeText({
      actor: "hermes",
      path: target,
      roots,
      content: validFrontmatter("mission-alpha", "run-1") + "# Forbidden\n",
    })).rejects.toThrow(/Hermes write denied/);
  });

  it("keeps request paths immutable after Pi creates them", async () => {
    const roots = await createRoots();
    const runRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-alpha", "runs", "run-1");
    const { requestDir } = await ensureMissionRunSkeleton({ missionRoot: runRoot });
    const requestPath = join(requestDir, "request.json");

    await writeKnowledgeJson({
      actor: "pi",
      path: requestPath,
      roots,
      mode: "create",
      value: { mission_id: "mission-alpha", run_id: "run-1" },
    });

    await expect(writeKnowledgeJson({
      actor: "pi",
      path: requestPath,
      roots,
      mode: "create",
      value: { mission_id: "mission-alpha", run_id: "run-1", changed: true },
    })).rejects.toThrow(/immutable path/);
  });

  it("enforces append-only trace behavior for Hermes", async () => {
    const roots = await createRoots();
    const runRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-alpha", "runs", "run-1");
    const { tracesDir } = await ensureMissionRunSkeleton({ missionRoot: runRoot });
    const tracePath = join(tracesDir, "trace-mission-alpha-run-1.jsonl");

    await writeKnowledgeText({ actor: "hermes", path: tracePath, roots, mode: "create", content: '{"event":"started"}\n' });
    await writeKnowledgeText({ actor: "hermes", path: tracePath, roots, mode: "append", content: '{"event":"completed"}\n' });
    await expect(writeKnowledgeText({ actor: "hermes", path: tracePath, roots, mode: "overwrite", content: '{"event":"rewrite"}\n' })).rejects.toThrow(/append-only/);

    const text = await readFile(tracePath, "utf8");
    expect(text).toContain('"started"');
    expect(text).toContain('"completed"');
  });

  it("denies Hermes create-mode writes that would truncate an existing trace", async () => {
    const roots = await createRoots();
    const runRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-alpha", "runs", "run-2");
    const { tracesDir } = await ensureMissionRunSkeleton({ missionRoot: runRoot });
    const tracePath = join(tracesDir, "trace-mission-alpha-run-2.jsonl");

    await writeKnowledgeText({ actor: "hermes", path: tracePath, roots, mode: "create", content: '{"event":"started"}\n' });
    await expect(writeKnowledgeText({ actor: "hermes", path: tracePath, roots, mode: "create", content: '{"event":"rewrite"}\n' })).rejects.toThrow(/append-only/);

    const text = await readFile(tracePath, "utf8");
    expect(text).toContain('"started"');
    expect(text).not.toContain('"rewrite"');
  });

  it("requires frontmatter for every markdown extension, including .markdown", async () => {
    const roots = await createRoots();
    for (const name of ["note.md", "note.mdown", "note.markdown", "note.MD"]) {
      const info = classifyKnowledgePath(join(roots.agenticKbRoot, "staging/normalized", name), roots);
      expect(info.requiresFrontmatter, name).toBe(true);
    }
    const nonMarkdown = classifyKnowledgePath(join(roots.agenticKbRoot, "staging/normalized", "note.txt"), roots);
    expect(nonMarkdown.requiresFrontmatter).toBe(false);
  });

  it("accepts CRLF line endings in required frontmatter", () => {
    const fields = [
      "id: kb-note-1",
      "trust: canonical",
      "created_by: hermes",
      "created_at: 2026-08-02T00:00:00Z",
      "mission_id: mission-1",
      "run_id: run-1",
      "source_paths:",
      "  - /tmp/source.md",
      "status: promoted",
    ];
    const crlf = ["---", ...fields, "---", "", "# Note", ""].join("\r\n");
    expect(hasFrontmatter(crlf)).toBe(true);
    expect(() => assertRequiredFrontmatter(crlf, "/tmp/note.md")).not.toThrow();

    const lf = ["---", ...fields, "---", "", "# Note", ""].join("\n");
    expect(() => assertRequiredFrontmatter(lf, "/tmp/note.md")).not.toThrow();
  });

  it("classifies dot-dot-prefixed names inside a root as inside that root", async () => {
    const roots = await createRoots();
    const weird = join(roots.agenticKbRoot, "..weird.md");
    const info = classifyKnowledgePath(weird, roots);
    expect(info.inAgenticKb).toBe(true);
    expect(info.pathClass).toBe("kb_other");

    const sibling = resolve(roots.agenticKbRoot, "..", "kb-sibling", "note.md");
    expect(classifyKnowledgePath(sibling, roots).pathClass).toBe("outside");
  });

  it("denies Hermes deletes outside approved knowledge roots", async () => {
    const roots = await createRoots();
    const outsideDir = await makeTempDir("kb-outside-");
    const target = join(outsideDir, "victim.txt");
    await writeFile(target, "do not touch\n", "utf8");

    await expect(deleteKnowledgePath({ actor: "hermes", path: target, roots })).rejects.toThrow(/outside approved knowledge roots/);
    await expect(access(target)).resolves.toBeUndefined();
  });

  it("denies Hermes deletes in Agentic-KB and allows Pi tombstones", async () => {
    const roots = await createRoots();
    const target = join(roots.agenticKbRoot, "queues", "discovery", "candidate.md");
    await writeKnowledgeText({ actor: "hermes", path: target, roots, content: validFrontmatter("mission-alpha", "run-1") + "# Candidate\n" });

    await expect(deleteKnowledgePath({ actor: "hermes", path: target, roots })).rejects.toThrow(/delete denied/);

    const tombstonePath = join(roots.agenticKbRoot, "archive", "rejected", "candidate.tombstone.md");
    await createKnowledgeTombstone({ actor: "pi", targetPath: target, tombstonePath, missionId: "mission-alpha", runId: "run-1", roots });
    expect(await readFile(tombstonePath, "utf8")).toContain("# Tombstone");
  });

  it("refuses to promote over an existing canonical target", async () => {
    const roots = await createRoots();
    const sourcePath = join(roots.llmWikiRoot, "drafts", "candidate.md");
    await writeKnowledgeText({ actor: "hermes", path: sourcePath, roots, content: "# Working Note\n\nUseful result.\n" });

    const targetPath = join(roots.agenticKbRoot, "knowledge", "promoted", "useful-result.md");
    const approvalPath = join(roots.agenticKbRoot, "supervision", "approvals", "approve-useful-result.md");
    const promote = () => promoteKnowledgeCandidate({
      sourcePath,
      targetPath,
      approvalPath,
      missionId: "mission-alpha",
      runId: "run-1",
      roots,
    });

    await promote();
    const canonical = await readFile(targetPath, "utf8");
    await expect(promote()).rejects.toThrow(/promotion target already exists/);
    expect(await readFile(targetPath, "utf8")).toBe(canonical);
  });

  it("lets Pi promote reviewed knowledge into canonical KB with approval lineage", async () => {
    const roots = await createRoots();
    const sourcePath = join(roots.llmWikiRoot, "drafts", "candidate.md");
    await writeKnowledgeText({ actor: "hermes", path: sourcePath, roots, content: "# Working Note\n\nUseful result.\n" });

    const targetPath = join(roots.agenticKbRoot, "knowledge", "promoted", "useful-result.md");
    const approvalPath = join(roots.agenticKbRoot, "supervision", "approvals", "approve-useful-result.md");
    await promoteKnowledgeCandidate({
      sourcePath,
      targetPath,
      approvalPath,
      missionId: "mission-alpha",
      runId: "run-1",
      roots,
    });

    const promoted = await readFile(targetPath, "utf8");
    const approval = await readFile(approvalPath, "utf8");
    expect(promoted).toContain("trust: canonical");
    expect(promoted).toContain("status: promoted");
    expect(approval).toContain("status: approved");
    expect(approval).toContain(targetPath);
  });

  it("runs a realistic governed mission with discovery to review to promotion lineage", async () => {
    const roots = await createRoots();
    const stateRoot = await makeTempDir("pi-hermes-kb-realistic-state-");
    const workdir = await makeTempDir("pi-hermes-kb-realistic-work-");
    await writeKnowledgeText({ actor: "pi", path: join(roots.agenticKbRoot, "contracts", "mission-contract.md"), roots, content: validFrontmatter("mission-real", "run-real") + "# Contract\n" });
    await writeKnowledgeText({ actor: "pi", path: join(roots.llmWikiRoot, "research", "topic.md"), roots, content: "# Topic\n\nBackground research.\n" });

    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      knowledgeRoots: roots,
      enforceKnowledgePolicy: true,
      heartbeatIntervalMs: 200,
      stuckTimeoutMs: 1500,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes-contract-v2.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const missionRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-realistic", "runs", "run-1");
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      const session = await sessionResponse.json() as { session_id: string };

      const outputsDir = join(missionRoot, "outputs");
      const tracesDir = join(missionRoot, "traces");
      const discoveryPath = join(roots.agenticKbRoot, "queues", "discovery", "disc-20260420-realistic-hermes-run-1.md");
      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "2.0",
          request_id: "req_realistic_1",
          run_id: "run_realistic_1",
          mission_id: "mission_realistic_1",
          session_id: session.session_id,
          execution_id: "exec_realistic_1",
          task_type: "repo_inspection",
          goal: "Read both repos and produce governed outputs plus one discovery candidate.",
          instructions: [
            `Read from ${join(roots.agenticKbRoot, "contracts")} and ${join(roots.llmWikiRoot, "research")}.`,
            `Write summary to ${join(outputsDir, "summary.md")}.`,
            `Write one discovery candidate to ${discoveryPath}.`,
          ],
          constraints: {
            network_access: false,
            write_access: true,
            path_allowlist: [outputsDir, tracesDir, join(roots.agenticKbRoot, "queues", "discovery")],
            path_denylist: [],
            side_effect_class: "local_write",
            requires_isolation: false,
          },
          allowed_tools: ["bash"],
          disallowed_tools: [],
          workdir,
          repo: { root: workdir, vcs: "git", worktree_path: workdir },
          branch: "main",
          timeout_seconds: 20,
          artifacts_expected: [
            { type: "summary", role: "primary_result", path: join(outputsDir, "summary.md"), required: true },
            { type: "discovery", role: "candidate_output", path: discoveryPath, required: true },
            { type: "result", role: "primary_result", path: join(outputsDir, "result.json"), required: true },
            { type: "manifest", role: "primary_result", path: join(outputsDir, "artifact-manifest.json"), required: true },
            { type: "trace", role: "supporting_log", path: join(tracesDir, "trace-realistic-run-1.json"), required: true },
          ],
          approval_policy: { mode: "never", allow_interrupt: true, allow_cancel: true },
          priority: "normal",
          metadata: { step_id: "step-1" },
        }),
      });
      expect(executeResponse.status).toBe(202);

      let run: any = null;
      for (let i = 0; i < 120; i++) {
        const runResponse = await fetch(`${base}/runs/exec_realistic_1`);
        run = await runResponse.json();
        if (["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.state)) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }

      expect(run.state).toBe("succeeded");
      expect(await readFile(discoveryPath, "utf8")).toContain("# Discovery Candidate");
      const promotedPath = join(roots.agenticKbRoot, "knowledge", "promoted", "realistic-discovery.md");
      const approvalPath = join(roots.agenticKbRoot, "supervision", "approvals", "approve-realistic-discovery.md");
      await promoteKnowledgeCandidate({
        sourcePath: discoveryPath,
        targetPath: promotedPath,
        approvalPath,
        missionId: "mission_realistic_1",
        runId: "run_realistic_1",
        roots,
      });
      expect(await readFile(promotedPath, "utf8")).toContain("trust: canonical");
      expect(await readFile(approvalPath, "utf8")).toContain("status: approved");
    } finally {
      await server.stop();
    }
  }, 20000);

  it("runs a golden mission through enforced KB write rules", async () => {
    const roots = await createRoots();
    const stateRoot = await makeTempDir("pi-hermes-kb-policy-state-");
    const workdir = await makeTempDir("pi-hermes-kb-policy-work-");
    const server = new HermesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      knowledgeRoots: roots,
      enforceKnowledgePolicy: true,
      heartbeatIntervalMs: 200,
      stuckTimeoutMs: 1500,
      adapterOptions: {
        command: process.execPath,
        commandArgsPrefix: [resolve("tests/fixtures/fake-hermes-contract-v2.mjs")],
        preferTransport: "subprocess",
        stateRoot,
      },
    });

    const missionRoot = join(roots.agenticKbRoot, "missions", "2026", "mission-alpha", "runs", "run-1");
    const listening = await server.start();
    const base = `http://${listening.host}:${listening.port}`;

    try {
      const sessionResponse = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      const session = await sessionResponse.json() as { session_id: string };

      const outputsDir = join(missionRoot, "outputs");
      const tracesDir = join(missionRoot, "traces");
      const executeResponse = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "2.0",
          request_id: "req_policy_1",
          run_id: "run_policy_1",
          mission_id: "mission_policy_1",
          session_id: session.session_id,
          execution_id: "exec_policy_1",
          task_type: "repo_inspection",
          goal: "Run under KB access policy enforcement.",
          instructions: ["Write the required summary artifact."],
          constraints: {
            network_access: false,
            write_access: true,
            path_allowlist: [outputsDir, tracesDir],
            path_denylist: [],
            side_effect_class: "local_write",
            requires_isolation: false,
          },
          allowed_tools: ["bash"],
          disallowed_tools: [],
          workdir,
          repo: { root: workdir, vcs: "git", worktree_path: workdir },
          branch: "main",
          timeout_seconds: 20,
          artifacts_expected: [
            { type: "summary", role: "primary_result", path: join(outputsDir, "summary.md"), required: true },
            { type: "result", role: "primary_result", path: join(outputsDir, "result.json"), required: true },
            { type: "manifest", role: "primary_result", path: join(outputsDir, "artifact-manifest.json"), required: true },
            { type: "trace", role: "supporting_log", path: join(tracesDir, "trace-mission-policy-run-1.json"), required: true },
          ],
          approval_policy: { mode: "never", allow_interrupt: true, allow_cancel: true },
          priority: "normal",
          metadata: { step_id: "step-1" },
        }),
      });
      expect(executeResponse.status).toBe(202);

      let run: any = null;
      for (let i = 0; i < 120; i++) {
        const runResponse = await fetch(`${base}/runs/exec_policy_1`);
        run = await runResponse.json();
        if (["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.state)) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }

      expect(run.state).toBe("succeeded");
      expect(run.run_kind).toBe("contract_v2");
      expect(run.result_envelope.status).toBe("succeeded");
      expect(await readFile(join(missionRoot, "request", "request.json"), "utf8")).toContain("mission_policy_1");
      expect(await readFile(join(outputsDir, "summary.md"), "utf8")).toContain("trust: staged");
      await expect(access(join(tracesDir, "trace-mission-policy-run-1.json"))).resolves.toBeUndefined();
    } finally {
      await server.stop();
    }
  }, 20000);

  it("denies a Hermes write whose symlinked path escapes the wiki root", async () => {
    const roots = await createRoots();
    const outside = await makeTempDir("kb-symlink-outside-");
    await symlink(outside, join(roots.llmWikiRoot, "escape"));
    const escapePath = join(roots.llmWikiRoot, "escape", "pwned.md");

    await expect(
      writeKnowledgeText({ actor: "hermes", path: escapePath, content: "escaped\n", roots }),
    ).rejects.toThrow(/refusing to follow symlink/);

    await expect(access(join(outside, "pwned.md"))).rejects.toThrow();
  });

  it("denies a symlink that crosses from a writable class into a governed class", async () => {
    const roots = await createRoots();
    const outputsDir = join(roots.agenticKbRoot, "missions/2026/mission-x/runs/run-1/outputs");
    await mkdir(outputsDir, { recursive: true });
    await symlink(join(roots.agenticKbRoot, "contracts"), join(outputsDir, "smuggle"));
    const smuggled = join(outputsDir, "smuggle", "canon.json");

    await expect(
      writeKnowledgeText({ actor: "hermes", path: smuggled, content: "{}\n", roots }),
    ).rejects.toThrow(/escapes its policy class/);
  });

  it("allows a legitimate write when a benign symlink sits above the root", async () => {
    const wikiRoot = await makeTempDir("llm-wiki-benign-");
    const realKb = await makeTempDir("agentic-kb-real-");
    const linkParent = await makeTempDir("agentic-kb-link-");
    const kbLink = join(linkParent, "kb");
    await symlink(realKb, kbLink);
    const roots = { agenticKbRoot: kbLink, llmWikiRoot: wikiRoot };
    const outputs = join(kbLink, "missions/2026/mission-x/runs/run-1/outputs/o.json");

    await writeKnowledgeText({ actor: "hermes", path: outputs, content: '{"a":1}\n', roots });
    const landed = await readFile(join(realKb, "missions/2026/mission-x/runs/run-1/outputs/o.json"), "utf8");
    expect(landed.trim()).toBe('{"a":1}');
  });
});

async function createRoots() {
  const agenticKbRoot = await makeTempDir("agentic-kb-");
  const llmWikiRoot = await makeTempDir("llm-wiki-");
  return ensureKnowledgeDirectorySkeleton({ agenticKbRoot, llmWikiRoot });
}

function validFrontmatter(missionId: string, runId: string): string {
  return [
    "---",
    "id: artifact-1",
    "trust: staged",
    "created_by: hermes",
    "created_at: 2026-04-20T00:00:00Z",
    `mission_id: ${missionId}`,
    `run_id: ${runId}`,
    "source_paths:",
    "  - /tmp/source.md",
    "status: candidate",
    "---",
    "",
  ].join("\n");
}
