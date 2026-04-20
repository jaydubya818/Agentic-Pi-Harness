import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const AbsolutePath = z.string().min(1).refine((value) => value.startsWith("/"), {
  message: "expected absolute path",
});

export const PiHermesContractVersionSchema = z.literal("2.0");

export const PiHermesRunStateSchema = z.enum([
  "queued",
  "accepted",
  "starting",
  "running",
  "waiting_approval",
  "blocked",
  "producing_artifacts",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
]);

export const PiHermesFailureClassSchema = z.enum([
  "transport_error",
  "contract_error",
  "validation_error",
  "policy_denied",
  "tool_error",
  "execution_error",
  "timeout",
  "stuck_run",
  "artifact_error",
  "partial_completion",
]);

export const PiHermesArtifactExpectedSchema = z.object({
  type: z.string().min(1),
  role: z.string().min(1),
  path: AbsolutePath,
  required: z.boolean(),
  description: z.string().optional(),
});

export const PiHermesArtifactManifestItemSchema = z.object({
  artifact_id: z.string().min(1),
  type: z.string().min(1),
  role: z.string().min(1),
  path: AbsolutePath,
  sha256: z.string().min(1).nullable().default(null),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string().min(1).nullable().default(null),
  created_at: z.string().datetime(),
  produced_by: z.string().min(1),
  description: z.string().optional(),
});

export const PiHermesTaskEnvelopeV2Schema = z.object({
  schema_version: PiHermesContractVersionSchema,
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  mission_id: z.string().min(1),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  task_type: z.string().min(1),
  goal: z.string().min(1),
  instructions: z.array(z.string().min(1)).min(1),
  constraints: z.object({
    network_access: z.boolean(),
    write_access: z.boolean(),
    max_steps: z.number().int().positive().optional(),
    max_subprocess_depth: z.number().int().nonnegative().optional(),
    path_allowlist: z.array(AbsolutePath).default([]),
    path_denylist: z.array(AbsolutePath).default([]),
    side_effect_class: z.string().min(1).optional(),
    requires_isolation: z.boolean().optional(),
  }),
  allowed_tools: z.array(z.string().min(1)).default([]),
  disallowed_tools: z.array(z.string().min(1)).default([]),
  workdir: AbsolutePath,
  repo: z.object({
    root: AbsolutePath,
    vcs: z.string().min(1).optional(),
    remote: z.string().min(1).optional(),
    commit_sha: z.string().min(1).optional(),
    worktree_path: AbsolutePath.optional(),
  }).optional(),
  branch: z.string().min(1).optional(),
  timeout_seconds: z.number().int().positive().max(86400),
  budget: z.object({
    max_tokens: z.number().int().positive().optional(),
    max_cost_usd: z.number().nonnegative().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    max_runtime_seconds: z.number().int().positive().optional(),
  }).optional(),
  artifacts_expected: z.array(PiHermesArtifactExpectedSchema).min(1),
  approval_policy: z.object({
    mode: z.string().min(1),
    allow_interrupt: z.boolean(),
    allow_cancel: z.boolean(),
    requires_supervisor_on_retry: z.boolean().optional(),
  }),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  metadata: z.record(z.unknown()).default({}),
});

export const PiHermesResultEnvelopeV2Schema = z.object({
  schema_version: PiHermesContractVersionSchema,
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  mission_id: z.string().min(1),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted", "timed_out", "partial_completion"]),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative(),
  summary: z.string(),
  result: z.record(z.unknown()).nullable().default(null),
  artifact_manifest: z.array(PiHermesArtifactManifestItemSchema),
  logs_ref: z.record(z.unknown()).nullable().default(null),
  error: z.record(z.unknown()).nullable().default(null),
  failure_class: PiHermesFailureClassSchema.nullable().default(null),
  next_action_needed: z.string().nullable().default(null),
  metrics: z.record(z.unknown()).nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const PiHermesStructuredEventV2Schema = z.object({
  event_id: z.number().int().positive(),
  timestamp: z.string().datetime(),
  schema_version: PiHermesContractVersionSchema,
  event_type: z.enum([
    "run.accepted",
    "run.started",
    "task.heartbeat",
    "run.progress",
    "run.waiting_approval",
    "run.blocked",
    "artifact.produced",
    "artifact.validated",
    "kb.write_allowed",
    "kb.write_denied",
    "kb.frontmatter_validation_failed",
    "kb.request_immutable_violation",
    "kb.trace_overwrite_denied",
    "kb.queue_create",
    "kb.queue_mutation_denied",
    "kb.promotion_completed",
    "kb.delete_denied",
    "kb.tombstone_created",
    "run.completed",
    "run.failed",
    "run.interrupted",
    "run.cancelled",
    "run.timed_out",
  ]),
  state: PiHermesRunStateSchema,
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  mission_id: z.string().min(1),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  agent: z.string().min(1),
  message: z.string().nullable().default(null),
  artifact_refs: z.array(z.string().min(1)).default([]),
  payload: z.record(z.unknown()).default({}),
  error_code: z.string().nullable().default(null),
});

export type PiHermesTaskEnvelopeV2 = z.infer<typeof PiHermesTaskEnvelopeV2Schema>;
export type PiHermesResultEnvelopeV2 = z.infer<typeof PiHermesResultEnvelopeV2Schema>;
export type PiHermesArtifactManifestItem = z.infer<typeof PiHermesArtifactManifestItemSchema>;
export type PiHermesStructuredEventV2 = z.infer<typeof PiHermesStructuredEventV2Schema>;
export type PiHermesRunState = z.infer<typeof PiHermesRunStateSchema>;
export type PiHermesFailureClass = z.infer<typeof PiHermesFailureClassSchema>;

const ALLOWED_TRANSITIONS: Record<PiHermesRunState, PiHermesRunState[]> = {
  queued: ["accepted", "cancelled"],
  accepted: ["starting", "cancelled", "failed"],
  starting: ["running", "failed", "cancelled", "timed_out"],
  running: ["waiting_approval", "blocked", "producing_artifacts", "failed", "interrupted", "cancelled", "timed_out"],
  waiting_approval: ["running", "cancelled", "failed", "timed_out"],
  blocked: ["running", "failed", "cancelled", "timed_out"],
  producing_artifacts: ["succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  timed_out: [],
};

export function assertValidStateTransition(current: PiHermesRunState, next: PiHermesRunState): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid state transition: ${current} -> ${next}`);
  }
}

export function isTerminalV2State(state: PiHermesRunState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "cancelled"
    || state === "interrupted"
    || state === "timed_out";
}

export function deriveArtifactRoot(task: PiHermesTaskEnvelopeV2): string {
  const dirs = [...new Set(task.artifacts_expected.map((artifact) => dirname(artifact.path)))];
  if (dirs.length !== 1) {
    throw new Error("artifacts_expected must share a single artifact root for Contract V2 golden mission path");
  }
  return resolve(dirs[0]);
}

export function buildLegacyObjectiveFromV2(task: PiHermesTaskEnvelopeV2): string {
  const lines = [
    `Task type: ${task.task_type}`,
    `Goal: ${task.goal}`,
    "Instructions:",
    ...task.instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
    "Expected artifacts:",
    ...task.artifacts_expected.map((artifact) => `- ${artifact.type}/${artifact.role}: ${artifact.path} required=${artifact.required}`),
    "Return the required structured result block only.",
  ];
  return lines.join("\n");
}

export async function computeArtifactManifestItem(input: {
  artifactId: string;
  type: string;
  role: string;
  path: string;
  producedBy: string;
  description?: string;
}): Promise<PiHermesArtifactManifestItem> {
  const filePath = resolve(input.path);
  const fileStat = await stat(filePath);
  const content = await readFile(filePath);
  return PiHermesArtifactManifestItemSchema.parse({
    artifact_id: input.artifactId,
    type: input.type,
    role: input.role,
    path: filePath,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    size_bytes: fileStat.size,
    mime_type: inferMimeType(filePath),
    created_at: new Date(fileStat.mtimeMs).toISOString(),
    produced_by: input.producedBy,
    description: input.description,
  });
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function inferMimeType(path: string): string | null {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".log")) return "text/plain";
  if (path.endsWith(".patch") || path.endsWith(".diff")) return "text/x-diff";
  return null;
}
