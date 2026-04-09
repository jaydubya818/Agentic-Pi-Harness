import { z } from "zod";
import { StreamEventSchema } from "./streamEvent.js";

export const TAPE_HEADER_SCHEMA_VERSION = 1 as const;
export const TAPE_EVENT_RECORD_SCHEMA_VERSION = 1 as const;

export const TapeHeaderSchema = z.object({
  type: z.literal("header"),
  schemaVersion: z.literal(TAPE_HEADER_SCHEMA_VERSION),
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
  schemaVersion: z.literal(TAPE_EVENT_RECORD_SCHEMA_VERSION),
  seq: z.number(),
  event: StreamEventSchema,
  prevHash: z.string(),
  recordHash: z.string(),
});

export const TapeRecordSchema = z.discriminatedUnion("type", [
  TapeHeaderSchema,
  TapeEventRecordSchema,
]);

export type TapeRecord = z.infer<typeof TapeRecordSchema>;
