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
  // One serialization for both the trigger check and the record's
  // bytesBefore. shouldCompactHistory + historyByteLength each JSON.stringify
  // the entire event history, and compaction runs precisely when that history
  // is at its largest, so the second identical pass was pure cost on the
  // biggest input the loop ever hands this function.
  const bytesBefore = historyByteLength(events);
  if (bytesBefore <= opts.targetBytes) {
    return { events, record: null };
  }

  // Only replace a body the placeholder is actually smaller than.
  // `compactToolResultOutput` is a fixed ~40-byte string, so swapping it in
  // for a short tool_result ("ok", an exit code, an empty diff) makes the
  // history *bigger*. A turn whose budget was blown by text_delta events but
  // whose tool results are all small therefore came back with
  // `bytesAfter > bytesBefore` while still reporting a compaction record and
  // incrementing `compaction.applied` -- the loop recorded, as evidence, that
  // it had compacted a history it had in fact grown.
  //
  // Filtered here rather than in `selectCompactableSegments`, which answers
  // the different question "which events are tool_result bodies" and is used
  // on its own.
  const segments = selectCompactableSegments(events).filter(
    (segment) => Buffer.byteLength(compactToolResultOutput(segment.toolCallId, segment.bytes), "utf8") < segment.bytes,
  );
  if (segments.length === 0) {
    return { events, record: null };
  }

  const segmentsByIndex = new Map(segments.map((segment) => [segment.index, segment]));
  const compactedEvents = events.map((event, index) => {
    const segment = segmentsByIndex.get(index);
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
      bytesBefore,
      bytesAfter: historyByteLength(compactedEvents),
      compactedToolCallIds: segments.map((segment) => segment.toolCallId),
      compactedEventIndexes: segments.map((segment) => segment.index),
    },
  };
}
