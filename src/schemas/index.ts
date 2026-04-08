import { z } from "zod";

// -------- SessionContext --------
export const SessionContextSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  parentSessionId: z.string().nullable(),
  mode: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]),
  createdAt: z.string(),
  labels: z.record(z.string()).default({}),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

// -------- ProvenanceManifest --------
export const ProvenanceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  loopGitSha: z.string(),
  repoGitSha: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  costTableVersion: z.string(),
  piMdDigest: z.string().nullable(),
  policyDigest: z.string(),
  createdAt: z.string(),
});
export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>;

// -------- StreamEvent --------
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), schemaVersion: z.literal(1) }),
  z.object({ type: z.literal("text_delta"), schemaVersion: z.literal(1), text: z.string() }),
  z.object({ type: z.literal("tool_use"), schemaVersion: z.literal(1), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), schemaVersion: z.literal(1), id: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal("message_stop"), schemaVersion: z.literal(1), stopReason: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

// -------- EffectRecord --------
export const EffectRecordSchema = z.object({
  schemaVersion: z.literal(1),
  toolCallId: z.string(),
  toolName: z.string(),
  paths: z.array(z.string()),
  preHashes: z.record(z.string()),
  postHashes: z.record(z.string()),
  unifiedDiff: z.string(),
  binaryChanged: z.boolean(),
  rollbackConfidence: z.enum(["high", "partial", "best_effort", "none"]),
  at: z.string(),
});
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

// -------- ToolAuditRecord --------
export const ToolAuditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  toolCallId: z.string(),
  toolName: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  inputDigest: z.string(),
  outputDigest: z.string(),
  isError: z.boolean(),
});
export type ToolAuditRecord = z.infer<typeof ToolAuditRecordSchema>;

// -------- SanitizationRecord --------
export const SanitizationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  toolCallId: z.string(),
  rewrites: z.array(z.enum(["ansi", "nested_tag", "control_char", "truncate"])),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
});
export type SanitizationRecord = z.infer<typeof SanitizationRecordSchema>;

// -------- PolicyDecision --------
export const PolicyDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  toolCallId: z.string(),
  result: z.enum(["approve", "deny", "ask"]),
  provenanceMode: z.enum(["placeholder", "full"]),
  matchedRuleIds: z.array(z.string()),
  winningRuleId: z.string().nullable(),
  evaluationOrder: z.array(z.string()),
  modeInfluence: z.string().nullable(),
  manifestInfluence: z.string().nullable(),
  hookInfluence: z.string().nullable(),
  at: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// -------- Checkpoint --------
export const CheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  turnIndex: z.number(),
  messageCount: z.number(),
  lastEventAt: z.string(),
  stopReason: z.string().nullable(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// -------- Replay tape records --------
export const TapeHeaderSchema = z.object({
  type: z.literal("header"),
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  createdAt: z.string(),
  loopGitSha: z.string(),
  policyDigest: z.string(),
  costTableVersion: z.string(),
  prevHash: z.string(),
  recordHash: z.string(),
});
export const TapeEventRecordSchema = z.object({
  type: z.literal("event"),
  schemaVersion: z.literal(1),
  seq: z.number(),
  event: StreamEventSchema,
  prevHash: z.string(),
  recordHash: z.string(),
});
export const TapeRecordSchema = z.discriminatedUnion("type", [TapeHeaderSchema, TapeEventRecordSchema]);
export type TapeRecord = z.infer<typeof TapeRecordSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, ctx = "parse"): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`${ctx}: ${r.error.message}`);
  return r.data;
}
