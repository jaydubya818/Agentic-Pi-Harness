import { z } from "zod";

export const EFFECT_RECORD_SCHEMA_VERSION = 1 as const;

export const EffectRecordSchema = z.object({
  schemaVersion: z.literal(EFFECT_RECORD_SCHEMA_VERSION),
  toolCallId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  paths: z.array(z.string()),
  preHashes: z.record(z.string()),
  postHashes: z.record(z.string()),
  unifiedDiff: z.string(),
  binaryChanged: z.boolean(),
  timestamp: z.string(),
});

export type EffectRecord = z.infer<typeof EffectRecordSchema>;
