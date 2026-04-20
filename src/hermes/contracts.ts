import { z } from "zod";

const AbsolutePath = z.string().min(1).refine((value) => value.startsWith("/"), {
  message: "expected absolute path",
});

export const HermesArtifactSchema = z.object({
  type: z.string().min(1),
  path: AbsolutePath,
});

export const HermesTaskMetadataSchema = z.object({
  mission_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  step_id: z.string().min(1).optional(),
}).default({});

export const HermesTaskRequestSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  execution_id: z.string().min(1).optional(),
  objective: z.string().min(1),
  workdir: AbsolutePath,
  allowed_tools: z.array(z.string().min(1)).default([]),
  allowed_actions: z.array(z.string().min(1)).default([]),
  timeout_seconds: z.number().int().positive().max(86400),
  output_dir: AbsolutePath,
  metadata: HermesTaskMetadataSchema,
});

export const HermesTaskStatusSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const HermesTaskAcceptedSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  status: z.literal("accepted"),
});

export const HermesTaskResultSchema = z.object({
  execution_id: z.string().min(1),
  status: HermesTaskStatusSchema,
  summary: z.string(),
  artifacts: z.array(HermesArtifactSchema).default([]),
  error: z.string().nullable().default(null),
  structured_output: z.boolean().default(false),
});

export const HermesTaskEventTypeSchema = z.enum([
  "task.started",
  "task.output",
  "task.progress",
  "task.heartbeat",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export const HermesTaskEventSchema = z.object({
  type: HermesTaskEventTypeSchema,
  session_id: z.string().min(1),
  execution_id: z.string().min(1),
  at: z.string().datetime(),
  data: z.record(z.unknown()).default({}),
});

export const HermesSessionSchema = z.object({
  session_id: z.string().min(1),
  workdir: AbsolutePath,
  profile: z.string().min(1).nullable().default(null),
  runtime_dir: AbsolutePath,
  hermes_session_id: z.string().min(1).nullable().default(null),
  status: z.enum(["idle", "running", "closed"]).default("idle"),
  created_at: z.string().datetime(),
});

export type HermesArtifact = z.infer<typeof HermesArtifactSchema>;
export type HermesTaskMetadata = z.infer<typeof HermesTaskMetadataSchema>;
export type HermesTaskRequest = z.infer<typeof HermesTaskRequestSchema>;
export type HermesTaskStatus = z.infer<typeof HermesTaskStatusSchema>;
export type HermesTaskAccepted = z.infer<typeof HermesTaskAcceptedSchema>;
export type HermesTaskResult = z.infer<typeof HermesTaskResultSchema>;
export type HermesTaskEventType = z.infer<typeof HermesTaskEventTypeSchema>;
export type HermesTaskEvent = z.infer<typeof HermesTaskEventSchema>;
export type HermesSession = z.infer<typeof HermesSessionSchema>;
