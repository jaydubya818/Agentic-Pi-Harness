import { z } from "zod";

export const SESSION_METRICS_SCHEMA_VERSION = 1 as const;

export const SessionMetricsSchema = z.object({
  schemaVersion: z.literal(SESSION_METRICS_SCHEMA_VERSION),
  sessionId: z.string(),
  counters: z.record(z.number()),
  capturedAt: z.string(),
});

export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;
