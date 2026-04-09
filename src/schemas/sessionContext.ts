import { z } from "zod";

export const SESSION_CONTEXT_SCHEMA_VERSION = 1 as const;

export const SessionContextSchema = z.object({
  schemaVersion: z.literal(SESSION_CONTEXT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  parentSessionId: z.string().nullable(),
  mode: z.enum(["plan", "assist", "autonomous", "worker", "dry-run"]),
  createdAt: z.string(),
  labels: z.record(z.string()).default({}),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
