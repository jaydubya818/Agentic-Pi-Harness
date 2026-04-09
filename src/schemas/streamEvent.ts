import { z } from "zod";

export const STREAM_EVENT_SCHEMA_VERSION = 1 as const;

export const MessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  schemaVersion: z.literal(STREAM_EVENT_SCHEMA_VERSION),
});

export const TextDeltaEventSchema = z.object({
  type: z.literal("text_delta"),
  schemaVersion: z.literal(STREAM_EVENT_SCHEMA_VERSION),
  text: z.string(),
});

export const ToolUseEventSchema = z.object({
  type: z.literal("tool_use"),
  schemaVersion: z.literal(STREAM_EVENT_SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  schemaVersion: z.literal(STREAM_EVENT_SCHEMA_VERSION),
  id: z.string(),
  output: z.string(),
  isError: z.boolean(),
});

export const MessageStopEventSchema = z.object({
  type: z.literal("message_stop"),
  schemaVersion: z.literal(STREAM_EVENT_SCHEMA_VERSION),
  stopReason: z.string(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  MessageStartEventSchema,
  TextDeltaEventSchema,
  ToolUseEventSchema,
  ToolResultEventSchema,
  MessageStopEventSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;
