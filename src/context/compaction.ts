import { StreamEvent } from "../schemas/index.js";

export interface CompactionRecord {
  strategy: "compact_tool_result_bodies";
  trigger: "target_bytes_exceeded";
  targetBytes: number;
  bytesBefore: number;
  bytesAfter: number;
  compactedToolCallIds: string[];
  compactedEventIndexes: number[];
}

export interface CompactOptions {
  targetBytes: number;
}

export interface CompactableSegment {
  index: number;
  toolCallId: string;
  bytes: number;
}

export function historyByteLength(events: StreamEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

export function shouldCompactHistory(events: StreamEvent[], targetBytes: number): boolean {
  return historyByteLength(events) > targetBytes;
}

export function selectCompactableSegments(events: StreamEvent[]): CompactableSegment[] {
  const segments: CompactableSegment[] = [];
  events.forEach((event, index) => {
    if (event.type !== "tool_result") return;
    segments.push({
      index,
      toolCallId: event.id,
      bytes: Buffer.byteLength(event.output, "utf8"),
    });
  });
  return segments;
}

export function compactToolResultOutput(toolCallId: string, bytes: number): string {
  return `[compacted tool_result id=${toolCallId} bytes=${bytes}]`;
}

export function compactHistory(events: StreamEvent[], opts: CompactOptions): { events: StreamEvent[]; record: CompactionRecord | null } {
  if (!shouldCompactHistory(events, opts.targetBytes)) {
    return { events, record: null };
  }

  const segments = selectCompactableSegments(events);
  if (segments.length === 0) {
    return { events, record: null };
  }

  const compactedEvents = events.map((event, index) => {
    const segment = segments.find((candidate) => candidate.index === index);
    if (!segment || event.type !== "tool_result") return event;
    return {
      ...event,
      output: compactToolResultOutput(segment.toolCallId, segment.bytes),
    };
  });

  return {
    events: compactedEvents,
    record: {
      strategy: "compact_tool_result_bodies",
      trigger: "target_bytes_exceeded",
      targetBytes: opts.targetBytes,
      bytesBefore: historyByteLength(events),
      bytesAfter: historyByteLength(compactedEvents),
      compactedToolCallIds: segments.map((segment) => segment.toolCallId),
      compactedEventIndexes: segments.map((segment) => segment.index),
    },
  };
}
