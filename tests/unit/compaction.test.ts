import { describe, it, expect } from "vitest";
import { compact } from "../../src/context/compaction.js";
import { StreamEvent } from "../../src/schemas/index.js";

function bigToolResult(i: number): StreamEvent {
  return { type: "tool_result", schemaVersion: 1, id: "t" + i, output: "x".repeat(2000), isError: false };
}

describe("compact", () => {
  it("no-op under budget", () => {
    const events: StreamEvent[] = [{ type: "message_start", schemaVersion: 1 }];
    const { events: out, record } = compact(events, { targetBytes: 10_000 });
    expect(out).toEqual(events);
    expect(record.strategiesApplied).toEqual([]);
  });

  it("drops tool bodies first", () => {
    const events = [bigToolResult(1), bigToolResult(2), bigToolResult(3)];
    const { events: out, record } = compact(events, { targetBytes: 500 });
    expect(record.strategiesApplied[0]).toBe("drop_tool_output_bodies");
    expect((out[0] as any).output).toMatch(/\[compacted/);
  });

  it("escalates to hard truncate when needed", () => {
    const events: StreamEvent[] = Array.from({ length: 50 }, (_, i) => bigToolResult(i));
    const { record } = compact(events, { targetBytes: 100, keepTurns: 1, keepLast: 2 });
    expect(record.strategiesApplied).toContain("hard_truncate");
    expect(record.eventsAfter).toBeLessThanOrEqual(3);
  });
});
