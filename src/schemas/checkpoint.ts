import { z } from "zod";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

export const CheckpointSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  sessionId: z.string(),
  turnIndex: z.number(),
  messageCount: z.number(),
  lastEventAt: z.string(),
  stopReason: z.string().nullable(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
