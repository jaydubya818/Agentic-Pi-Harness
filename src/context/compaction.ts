import { z } from "zod";
import { StreamEvent } from "../schemas/index.js";

/**
 * Tier B compaction. Four strategies applied in order until we fit the budget:
 *
 *   1. `drop_tool_output_bodies` — keep tool_use + tool_result metadata, replace
 *      bodies with `[compacted n bytes]`.
 *   2. `summarize_text_deltas`   — collapse runs of text_delta into a single
 *      synthetic summary delta.
 *   3. `drop_early_turns`        — drop events before the most recent N turns,
 *      keeping the message_start/stop boundaries intact.
 *   4. `hard_truncate`           — last resort: keep only the most recent M
 *      events with a leading synthetic marker.
 *
 * Every compaction run emits a CompactionRecord describing which strategies
 * fired and how many bytes/events they removed.
 */

export const CompactionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  at: z.string(),
  strategiesApplied: z.array(z.enum([
    "drop_tool_output_bodies",
    "summarize_text_deltas",
    "drop_early_turns",
    "hard_truncate",
  ])),
  eventsBefore: z.number(),
  eventsAfter: z.number(),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
  targetBytes: z.number(),
});
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;

function sizeOf(events: StreamEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

function dropToolOutputBodies(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (e.type === "tool_result") {
      const n = Buffer.byteLength(e.output, "utf8");
      return { ...e, output: `[compacted ${n} bytes]` };
    }
    return e;
  });
}

function summarizeTextDeltas(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 1) {
      out.push({ type: "text_delta", schemaVersion: 1, text: `[summarized ${buf.length} deltas, ${buf.join("").length} chars]` });
    } else if (buf.length === 1) {
      out.push({ type: "text_delta", schemaVersion: 1, text: buf[0] });
    }
    buf = [];
  };
  for (const e of events) {
    if (e.type === "text_delta") { buf.push(e.text); continue; }
    flush();
    out.push(e);
  }
  flush();
  return out;
}

function dropEarlyTurns(events: StreamEvent[], keepTurns: number): StreamEvent[] {
  const starts: number[] = [];
  events.forEach((e, i) => { if (e.type === "message_start") starts.push(i); });
  if (starts.length <= keepTurns) return events;
  const cut = starts[starts.length - keepTurns];
  return [
    { type: "text_delta", schemaVersion: 1, text: `[dropped ${cut} earlier events across ${starts.length - keepTurns} turns]` },
    ...events.slice(cut),
  ];
}

function hardTruncate(events: StreamEvent[], keepLast: number): StreamEvent[] {
  if (events.length <= keepLast) return events;
  return [
    { type: "text_delta", schemaVersion: 1, text: `[hard-truncated ${events.length - keepLast} events]` },
    ...events.slice(-keepLast),
  ];
}

export interface CompactOptions {
  targetBytes: number;
  keepTurns?: number;   // default 2
  keepLast?: number;    // default 20
}

export function compact(events: StreamEvent[], opts: CompactOptions): { events: StreamEvent[]; record: CompactionRecord } {
  const before = events.slice();
  const bytesBefore = sizeOf(before);
  const strategies: CompactionRecord["strategiesApplied"] = [];
  let cur = events;

  if (sizeOf(cur) > opts.targetBytes) { cur = dropToolOutputBodies(cur); strategies.push("drop_tool_output_bodies"); }
  if (sizeOf(cur) > opts.targetBytes) { cur = summarizeTextDeltas(cur); strategies.push("summarize_text_deltas"); }
  if (sizeOf(cur) > opts.targetBytes) { cur = dropEarlyTurns(cur, opts.keepTurns ?? 2); strategies.push("drop_early_turns"); }
  if (sizeOf(cur) > opts.targetBytes) { cur = hardTruncate(cur, opts.keepLast ?? 20); strategies.push("hard_truncate"); }

  return {
    events: cur,
    record: {
      schemaVersion: 1,
      at: new Date().toISOString(),
      strategiesApplied: strategies,
      eventsBefore: before.length,
      eventsAfter: cur.length,
      bytesBefore,
      bytesAfter: sizeOf(cur),
      targetBytes: opts.targetBytes,
    },
  };
}
