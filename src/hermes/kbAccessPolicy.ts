import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export interface KnowledgeRoots {
  agenticKbRoot: string;
  llmWikiRoot: string;
}

export type KnowledgeActor = "pi" | "hermes";
export type KnowledgeWriteMode = "create" | "append" | "overwrite";

export type KnowledgePathClass =
  | "outside"
  | "wiki"
  | "kb_contracts"
  | "kb_standards"
  | "kb_promoted"
  | "kb_discovery"
  | "kb_handoff_inbound"
  | "kb_normalized"
  | "kb_supervision"
  | "kb_archive"
  | "kb_mission_request"
  | "kb_mission_outputs"
  | "kb_mission_traces"
  | "kb_mission_supervision"
  | "kb_other";

export interface KnowledgePathInfo {
  path: string;
  roots: KnowledgeRoots;
  pathClass: KnowledgePathClass;
  inAgenticKb: boolean;
  inLlmWiki: boolean;
  requiresFrontmatter: boolean;
  immutable: boolean;
  appendOnly: boolean;
}

export type KnowledgePolicyEventType =
  | "kb.write_allowed"
  | "kb.write_denied"
  | "kb.frontmatter_validation_failed"
  | "kb.request_immutable_violation"
  | "kb.trace_overwrite_denied"
  | "kb.queue_create"
  | "kb.queue_mutation_denied"
  | "kb.promotion_completed"
  | "kb.delete_denied"
  | "kb.tombstone_created";

export interface KnowledgePolicyEvent {
  type: KnowledgePolicyEventType;
  actor: KnowledgeActor;
  path: string;
  pathClass?: KnowledgePathClass;
  mode?: KnowledgeWriteMode;
  missionId?: string | null;
  runId?: string | null;
  detail?: string | null;
}

export interface KnowledgeWriteAssertionInput {
  actor: KnowledgeActor;
  path: string;
  mode: KnowledgeWriteMode;
  roots?: Partial<KnowledgeRoots>;
  exists?: boolean;
}

export interface WriteKnowledgeTextInput {
  actor: KnowledgeActor;
  path: string;
  content: string;
  mode?: KnowledgeWriteMode;
  roots?: Partial<KnowledgeRoots>;
  onEvent?: (event: KnowledgePolicyEvent) => void | Promise<void>;
}

export interface WriteKnowledgeJsonInput {
  actor: KnowledgeActor;
  path: string;
  value: unknown;
  mode?: KnowledgeWriteMode;
  roots?: Partial<KnowledgeRoots>;
  onEvent?: (event: KnowledgePolicyEvent) => void | Promise<void>;
}

export interface PromoteKnowledgeCandidateInput {
  sourcePath: string;
  targetPath: string;
  approvalPath: string;
  missionId: string;
  runId: string;
  createdBy?: string;
  promotedBy?: string;
  roots?: Partial<KnowledgeRoots>;
  onEvent?: (event: KnowledgePolicyEvent) => void | Promise<void>;
}

export interface DeleteKnowledgePathInput {
  actor: KnowledgeActor;
  path: string;
  roots?: Partial<KnowledgeRoots>;
  allowWikiDelete?: boolean;
  onEvent?: (event: KnowledgePolicyEvent) => void | Promise<void>;
}

export interface CreateKnowledgeTombstoneInput {
  actor: Extract<KnowledgeActor, "pi">;
  targetPath: string;
  tombstonePath: string;
  missionId: string;
  runId: string;
  roots?: Partial<KnowledgeRoots>;
  reason?: string;
  onEvent?: (event: KnowledgePolicyEvent) => void | Promise<void>;
}

const REQUIRED_FRONTMATTER_FIELDS = [
  "id",
  "trust",
  "created_by",
  "created_at",
  "mission_id",
  "run_id",
  "source_paths",
  "status",
] as const;

export function resolveKnowledgeRoots(roots: Partial<KnowledgeRoots> = {}): KnowledgeRoots {
  return {
    agenticKbRoot: resolve(roots.agenticKbRoot ?? join(homedir(), "Agentic-KB")),
    llmWikiRoot: resolve(roots.llmWikiRoot ?? join(homedir(), "My LLM Wiki")),
  };
}

export async function ensureKnowledgeDirectorySkeleton(rootsInput: Partial<KnowledgeRoots> = {}): Promise<KnowledgeRoots> {
  const roots = resolveKnowledgeRoots(rootsInput);
  const kbDirs = [
    "contracts",
    "standards",
    "knowledge/promoted",
    "queues/discovery",
    "handoffs/inbound",
    "staging/normalized",
    "supervision/reviews",
    "supervision/approvals",
    "supervision/rejections",
    "archive/rejected",
  ];
  const wikiDirs = [
    "inbox",
    "drafts",
    "research",
    "working-notes",
    "syntheses",
    "topic-pages",
    "archive",
  ];

  await mkdir(roots.agenticKbRoot, { recursive: true });
  await mkdir(roots.llmWikiRoot, { recursive: true });
  await Promise.all(kbDirs.map((dir) => mkdir(join(roots.agenticKbRoot, dir), { recursive: true })));
  await Promise.all(wikiDirs.map((dir) => mkdir(join(roots.llmWikiRoot, dir), { recursive: true })));
  return roots;
}

export async function ensureMissionRunSkeleton(input: {
  missionRoot: string;
}): Promise<{ requestDir: string; outputsDir: string; tracesDir: string; supervisionDir: string }> {
  const missionRoot = resolve(input.missionRoot);
  const requestDir = join(missionRoot, "request");
  const outputsDir = join(missionRoot, "outputs");
  const tracesDir = join(missionRoot, "traces");
  const supervisionDir = join(missionRoot, "supervision");
  await Promise.all([
    mkdir(requestDir, { recursive: true }),
    mkdir(outputsDir, { recursive: true }),
    mkdir(tracesDir, { recursive: true }),
    mkdir(supervisionDir, { recursive: true }),
  ]);
  return { requestDir, outputsDir, tracesDir, supervisionDir };
}

export function classifyKnowledgePath(path: string, rootsInput: Partial<KnowledgeRoots> = {}): KnowledgePathInfo {
  const roots = resolveKnowledgeRoots(rootsInput);
  const resolvedPath = resolve(path);
  const inAgenticKb = isWithin(roots.agenticKbRoot, resolvedPath);
  const inLlmWiki = isWithin(roots.llmWikiRoot, resolvedPath);

  let pathClass: KnowledgePathClass = "outside";
  if (inLlmWiki) {
    pathClass = "wiki";
  } else if (inAgenticKb) {
    const rel = relative(roots.agenticKbRoot, resolvedPath).replace(/\\/g, "/");
    if (rel === "contracts" || rel.startsWith("contracts/")) pathClass = "kb_contracts";
    else if (rel === "standards" || rel.startsWith("standards/")) pathClass = "kb_standards";
    else if (rel === "knowledge/promoted" || rel.startsWith("knowledge/promoted/")) pathClass = "kb_promoted";
    else if (rel === "queues/discovery" || rel.startsWith("queues/discovery/")) pathClass = "kb_discovery";
    else if (rel === "handoffs/inbound" || rel.startsWith("handoffs/inbound/")) pathClass = "kb_handoff_inbound";
    else if (rel === "staging/normalized" || rel.startsWith("staging/normalized/")) pathClass = "kb_normalized";
    else if (rel === "supervision" || rel.startsWith("supervision/")) pathClass = "kb_supervision";
    else if (rel === "archive" || rel.startsWith("archive/")) pathClass = "kb_archive";
    else if (/^missions\/\d{4}\/mission-[^/]+\/runs\/run-[^/]+\/request(?:\/|$)/.test(rel)) pathClass = "kb_mission_request";
    else if (/^missions\/\d{4}\/mission-[^/]+\/runs\/run-[^/]+\/outputs(?:\/|$)/.test(rel)) pathClass = "kb_mission_outputs";
    else if (/^missions\/\d{4}\/mission-[^/]+\/runs\/run-[^/]+\/traces(?:\/|$)/.test(rel)) pathClass = "kb_mission_traces";
    else if (/^missions\/\d{4}\/mission-[^/]+\/runs\/run-[^/]+\/supervision(?:\/|$)/.test(rel)) pathClass = "kb_mission_supervision";
    else pathClass = "kb_other";
  }

  const markdown = /\.md(?:own)?$/i.test(resolvedPath);
  return {
    path: resolvedPath,
    roots,
    pathClass,
    inAgenticKb,
    inLlmWiki,
    requiresFrontmatter: inAgenticKb && markdown && pathClass !== "kb_mission_traces",
    immutable: pathClass === "kb_mission_request",
    appendOnly: pathClass === "kb_mission_traces",
  };
}

export function assertKnowledgeWriteAllowed(input: KnowledgeWriteAssertionInput): KnowledgePathInfo {
  const info = classifyKnowledgePath(input.path, input.roots);
  const exists = input.exists ?? false;

  if (input.actor === "pi") {
    if (info.immutable && exists) {
      throw new Error(`immutable path cannot be modified after creation: ${info.path}`);
    }
    return info;
  }

  if (info.pathClass === "outside") {
    throw new Error(`Hermes write denied outside approved knowledge roots: ${info.path}`);
  }

  if (info.pathClass === "wiki") return info;
  if (info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound") {
    if (exists) {
      throw new Error(`Hermes queue items are create-only and may not be modified in place: ${info.path}`);
    }
    return info;
  }
  if (info.pathClass === "kb_mission_outputs") return info;
  if (info.pathClass === "kb_mission_traces") {
    if (input.mode === "overwrite") {
      throw new Error(`Hermes trace writes must be append-only or create-only: ${info.path}`);
    }
    return info;
  }

  throw new Error(`Hermes write denied for path class ${info.pathClass}: ${info.path}`);
}

export async function writeKnowledgeText(input: WriteKnowledgeTextInput): Promise<void> {
  const path = resolve(input.path);
  const exists = await fileExists(path);
  const mode = input.mode ?? (exists ? "overwrite" : "create");
  let info: KnowledgePathInfo;
  try {
    info = assertKnowledgeWriteAllowed({
      actor: input.actor,
      path,
      mode,
      roots: input.roots,
      exists,
    });
  } catch (error) {
    await emitPolicyEvent(input.onEvent, classifyKnowledgePath(path, input.roots), {
      type: classifyDeniedEvent(path, input.roots, String(error)),
      actor: input.actor,
      path,
      mode,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (info.requiresFrontmatter) {
    try {
      assertRequiredFrontmatter(input.content, path);
    } catch (error) {
      await emitPolicyEvent(input.onEvent, info, {
        type: "kb.frontmatter_validation_failed",
        actor: input.actor,
        path,
        mode,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  if (mode === "append") await writeAppend(path, input.content);
  else await writeFile(path, ensureTrailingNewline(input.content), "utf8");
  await emitPolicyEvent(input.onEvent, info, {
    type: info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound" ? "kb.queue_create" : "kb.write_allowed",
    actor: input.actor,
    path,
    mode,
  });
}

export async function writeKnowledgeJson(input: WriteKnowledgeJsonInput): Promise<void> {
  const path = resolve(input.path);
  const exists = await fileExists(path);
  const mode = input.mode ?? (exists ? "overwrite" : "create");
  let info: KnowledgePathInfo;
  try {
    info = assertKnowledgeWriteAllowed({
      actor: input.actor,
      path,
      mode,
      roots: input.roots,
      exists,
    });
  } catch (error) {
    await emitPolicyEvent(input.onEvent, classifyKnowledgePath(path, input.roots), {
      type: classifyDeniedEvent(path, input.roots, String(error)),
      actor: input.actor,
      path,
      mode,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const content = JSON.stringify(input.value, null, 2) + "\n";
  if (mode === "append") await writeAppend(path, content);
  else await writeFile(path, content, "utf8");
  await emitPolicyEvent(input.onEvent, info, {
    type: "kb.write_allowed",
    actor: input.actor,
    path,
    mode,
  });
}

export async function promoteKnowledgeCandidate(input: PromoteKnowledgeCandidateInput): Promise<{ targetPath: string; approvalPath: string }> {
  const roots = resolveKnowledgeRoots(input.roots);
  const sourcePath = resolve(input.sourcePath);
  const targetPath = resolve(input.targetPath);
  const approvalPath = resolve(input.approvalPath);
  const sourceContent = await readFile(sourcePath, "utf8");
  const promotedBy = input.promotedBy ?? "pi";
  const createdBy = input.createdBy ?? inferCreatedBy(sourceContent) ?? "pi";
  const now = new Date().toISOString();
  const id = `kb-${basename(targetPath).replace(/\.[^.]+$/, "")}`;
  const content = buildFrontmatter({
    id,
    trust: "canonical",
    created_by: createdBy,
    created_at: now,
    mission_id: input.missionId,
    run_id: input.runId,
    source_paths: [sourcePath],
    status: "promoted",
    promoted_by: promotedBy,
    promoted_at: now,
  }) + stripFrontmatter(sourceContent).replace(/^\s+/, "");

  await writeKnowledgeText({ actor: "pi", path: targetPath, content, mode: "create", roots, onEvent: input.onEvent });
  await writeKnowledgeText({
    actor: "pi",
    path: approvalPath,
    mode: "create",
    roots,
    onEvent: input.onEvent,
    content: buildFrontmatter({
      id: `approval-${basename(approvalPath).replace(/\.[^.]+$/, "")}`,
      trust: "canonical",
      created_by: "pi",
      created_at: now,
      mission_id: input.missionId,
      run_id: input.runId,
      source_paths: [sourcePath, targetPath],
      status: "approved",
    }) + [
      "# Approval",
      "",
      "Approved promotion of candidate into canonical knowledge.",
      "",
      `- source: ${sourcePath}`,
      `- target: ${targetPath}`,
      `- promoted_by: ${promotedBy}`,
    ].join("\n"),
  });
  await emitPolicyEvent(input.onEvent, classifyKnowledgePath(targetPath, roots), {
    type: "kb.promotion_completed",
    actor: "pi",
    path: targetPath,
    detail: `approved via ${approvalPath}`,
  });
  return { targetPath, approvalPath };
}

export async function deleteKnowledgePath(input: DeleteKnowledgePathInput): Promise<void> {
  const path = resolve(input.path);
  const info = classifyKnowledgePath(path, input.roots);

  if (input.actor === "hermes") {
    if (info.inAgenticKb) {
      await emitPolicyEvent(input.onEvent, info, {
        type: "kb.delete_denied",
        actor: input.actor,
        path,
        detail: "Hermes cannot delete anything in Agentic-KB",
      });
      throw new Error(`Hermes delete denied in Agentic-KB: ${path}`);
    }
    if (info.inLlmWiki && !input.allowWikiDelete) {
      await emitPolicyEvent(input.onEvent, info, {
        type: "kb.delete_denied",
        actor: input.actor,
        path,
        detail: "Hermes wiki deletes require explicit allowWikiDelete",
      });
      throw new Error(`Hermes wiki delete requires explicit allowWikiDelete: ${path}`);
    }
    if (info.inLlmWiki) {
      await unlink(path);
      return;
    }
  }

  if (input.actor === "pi" && info.inAgenticKb && ["kb_contracts", "kb_standards", "kb_promoted", "kb_normalized", "kb_supervision", "kb_mission_request", "kb_mission_outputs"].includes(info.pathClass)) {
    await emitPolicyEvent(input.onEvent, info, {
      type: "kb.delete_denied",
      actor: input.actor,
      path,
      detail: "Pi should archive or tombstone governed artifacts instead of deleting them directly",
    });
    throw new Error(`governed KB delete denied; archive or tombstone instead: ${path}`);
  }

  await unlink(path);
}

export async function createKnowledgeTombstone(input: CreateKnowledgeTombstoneInput): Promise<string> {
  const now = new Date().toISOString();
  const content = buildFrontmatter({
    id: `tombstone-${basename(input.tombstonePath).replace(/\.[^.]+$/, "")}`,
    trust: "canonical",
    created_by: "pi",
    created_at: now,
    mission_id: input.missionId,
    run_id: input.runId,
    source_paths: [resolve(input.targetPath)],
    status: "rejected",
  }) + [
    "# Tombstone",
    "",
    `target: ${resolve(input.targetPath)}`,
    `reason: ${input.reason ?? "replaced or retired"}`,
  ].join("\n");
  await writeKnowledgeText({ actor: "pi", path: input.tombstonePath, content, mode: "create", roots: input.roots, onEvent: input.onEvent });
  await emitPolicyEvent(input.onEvent, classifyKnowledgePath(input.tombstonePath, input.roots), {
    type: "kb.tombstone_created",
    actor: "pi",
    path: resolve(input.tombstonePath),
    detail: resolve(input.targetPath),
  });
  return resolve(input.tombstonePath);
}

export function assertRequiredFrontmatter(content: string, path: string): void {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) throw new Error(`required frontmatter missing for KB artifact: ${path}`);
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!(field in frontmatter) || frontmatter[field] === "" || frontmatter[field] == null) {
      throw new Error(`required frontmatter field missing (${field}) for KB artifact: ${path}`);
    }
  }
}

export function hasFrontmatter(content: string): boolean {
  return extractFrontmatter(content) !== null;
}

export function inferMissionRunRootFromPath(path: string, rootsInput: Partial<KnowledgeRoots> = {}): string | null {
  const info = classifyKnowledgePath(path, rootsInput);
  if (!["kb_mission_request", "kb_mission_outputs", "kb_mission_traces", "kb_mission_supervision"].includes(info.pathClass)) return null;
  let current = info.path;
  while (dirname(current) !== current) {
    const rel = relative(info.roots.agenticKbRoot, current).replace(/\\/g, "/");
    if (/^missions\/\d{4}\/mission-[^/]+\/runs\/run-[^/]+$/.test(rel)) return current;
    current = dirname(current);
  }
  return null;
}

export function deriveHermesOutputDirFromV2Artifacts(paths: string[], rootsInput: Partial<KnowledgeRoots> = {}): string {
  const infos = paths
    .map((path) => classifyKnowledgePath(path, rootsInput))
    .filter((info) => info.pathClass === "wiki" || info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound" || info.pathClass === "kb_mission_outputs");
  if (infos.length === 0) {
    throw new Error("no Hermes-writable artifact paths found in task envelope");
  }
  const preferred = infos.find((info) => info.pathClass === "kb_mission_outputs")
    ?? infos.find((info) => info.pathClass === "wiki")
    ?? infos[0];
  return resolve(dirname(preferred.path));
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAppend(path: string, content: string): Promise<void> {
  const existing = await fileExists(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, existing + ensureTrailingNewline(content), "utf8");
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function extractFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const lines = match[1].split("\n");
  const result: Record<string, string> = {};
  let currentListKey: string | null = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentListKey) {
      result[currentListKey] = result[currentListKey] ? `${result[currentListKey]}\n- ${listMatch[1]}` : `- ${listMatch[1]}`;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    currentListKey = kv[1];
    result[kv[1]] = kv[2];
  }
  return result;
}

function buildFrontmatter(fields: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function inferCreatedBy(content: string): string | null {
  const frontmatter = extractFrontmatter(content);
  return frontmatter?.created_by ?? null;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function classifyDeniedEvent(path: string, roots: Partial<KnowledgeRoots> | undefined, error: string): KnowledgePolicyEventType {
  const info = classifyKnowledgePath(path, roots);
  if (info.pathClass === "kb_mission_request") return "kb.request_immutable_violation";
  if (info.pathClass === "kb_mission_traces" && error.includes("append-only")) return "kb.trace_overwrite_denied";
  if ((info.pathClass === "kb_discovery" || info.pathClass === "kb_handoff_inbound") && error.includes("create-only")) return "kb.queue_mutation_denied";
  return "kb.write_denied";
}

async function emitPolicyEvent(
  onEvent: ((event: KnowledgePolicyEvent) => void | Promise<void>) | undefined,
  info: KnowledgePathInfo,
  event: Omit<KnowledgePolicyEvent, "pathClass">,
): Promise<void> {
  if (!onEvent) return;
  await onEvent({ ...event, pathClass: info.pathClass });
}
