import { z } from "zod";

export const SANITIZATION_RECORD_SCHEMA_VERSION = 1 as const;

export const SanitizationRecordSchema = z.object({
  schemaVersion: z.literal(SANITIZATION_RECORD_SCHEMA_VERSION),
  toolCallId: z.string(),
  rewrites: z.array(z.enum(["ansi", "nested_tag", "control_char", "truncate"])),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
});

export type SanitizationRecord = z.infer<typeof SanitizationRecordSchema>;
