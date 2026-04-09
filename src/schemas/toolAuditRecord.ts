import { z } from "zod";

export const TOOL_AUDIT_RECORD_SCHEMA_VERSION = 1 as const;

export const ToolAuditRecordSchema = z.object({
  schemaVersion: z.literal(TOOL_AUDIT_RECORD_SCHEMA_VERSION),
  toolCallId: z.string(),
  toolName: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  inputDigest: z.string(),
  outputDigest: z.string(),
  isError: z.boolean(),
});

export type ToolAuditRecord = z.infer<typeof ToolAuditRecordSchema>;
