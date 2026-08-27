import { describe, expect, it } from "vitest";
import {
  compactHistory,
  compactToolResultOutput,
  historyByteLength,
  selectCompactableSegments,
  shouldCompactHistory,
} from "../../src/context/compaction.js";
import { StreamEvent } from "../../src/schemas/index.js";

function eventsWithLargeToolOutputs(): StreamEvent[] {
  return [
    { type: "message_start", schemaVersion: 1 },
    { type: "text_delta", schemaVersion: 1, text: "Reading file." },
    { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: "tests/math.test.ts" } },
    { type: "tool_result", schemaVersion: 1, id: "t1", output: "x".repeat(2000), isError: false },
    { type: "tool_use", schemaVersion: 1, id: "t2", name: "read_file", input: { path: "tests/other.test.ts" } },
    { type: "tool_result", schemaVersion: 1, id: "t2", output: "y".repeat(1800), isError: false },
    { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
  ];
}

describe("compaction helpers", () => {
  it("is a no-op when below threshold", () => {
    const events: StreamEvent[] = [{ type: "message_start", schemaVersion: 1 }];
    const result = compactHistory(events, { targetBytes: 10_000 });

    expect(shouldCompactHistory(events, 10_000)).toBe(false);
    expect(result.events).toBe(events);
    expect(result.record).toBeNull();
  });

  it("uses deterministic trigger evaluation and compactable segment selection", () => {
    const events = eventsWithLargeToolOutputs();

    expect(shouldCompactHistory(events, historyByteLength(events) - 1)).toBe(true);
    expect(selectCompactableSegments(events)).toEqual([
      { index: 3, toolCallId: "t1", bytes: 2000 },
      { index: 5, toolCallId: "t2", bytes: 1800 },
    ]);
  });

  it("produces deterministic compacted output and leaves the source history unchanged", () => {
    const events = eventsWithLargeToolOutputs();
    const first = compactHistory(events, { targetBytes: 500 });
    const second = compactHistory(events, { targetBytes: 500 });

    expect(first).toEqual(second);
    expect(first.record).toEqual({
      strategy: "compact_tool_result_bodies",
      trigger: "target_bytes_exceeded",
      targetBytes: 500,
      bytesBefore: historyByteLength(events),
      bytesAfter: historyByteLength(first.events),
      compactedToolCallIds: ["t1", "t2"],
      compactedEventIndexes: [3, 5],
    });
    expect(first.events[3]).toEqual({
      type: "tool_result",
      schemaVersion: 1,
      id: "t1",
      output: compactToolResultOutput("t1", 2000),
      isError: false,
    });
    expect(first.events[5]).toEqual({
      type: "tool_result",
      schemaVersion: 1,
      id: "t2",
      output: compactToolResultOutput("t2", 1800),
      isError: false,
    });
    expect((events[3] as Extract<StreamEvent, { type: "tool_result" }>).output).toBe("x".repeat(2000));
    expect((events[5] as Extract<StreamEvent, { type: "tool_result" }>).output).toBe("y".repeat(1800));
    expect(historyByteLength(first.events)).toBeLessThan(historyByteLength(events));
  });

  it("does not claim a compaction that would grow the history", () => {
    // Over budget because of the text_delta, not the tool results. Every
    // tool_result body here is shorter than the fixed-size placeholder, so
    // replacing them made the history *larger* while still reporting a
    // compaction record and incrementing `compaction.applied` in the loop.
    const events: StreamEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push({ type: "tool_result", schemaVersion: 1, id: `c${i}`, output: "ok", isError: false });
    }
    events.push({ type: "text_delta", schemaVersion: 1, text: "x".repeat(4000) });

    const result = compactHistory(events, { targetBytes: 1000 });

    expect(compactToolResultOutput("c0", 2).length).toBeGreaterThan("ok".length);
    expect(result.record).toBeNull();
    expect(result.events).toBe(events);
    expect(historyByteLength(result.events)).toBe(historyByteLength(events));
  });

  it("compacts only the bodies the placeholder is smaller than", () => {
    const events: StreamEvent[] = [
      { type: "tool_result", schemaVersion: 1, id: "small", output: "ok", isError: false },
      { type: "tool_result", schemaVersion: 1, id: "large", output: "z".repeat(3000), isError: false },
    ];

    const result = compactHistory(events, { targetBytes: 500 });

    expect(result.record?.compactedToolCallIds).toEqual(["large"]);
    expect(result.record?.compactedEventIndexes).toEqual([1]);
    expect((result.events[0] as Extract<StreamEvent, { type: "tool_result" }>).output).toBe("ok");
    expect((result.events[1] as Extract<StreamEvent, { type: "tool_result" }>).output).toBe(
      compactToolResultOutput("large", 3000),
    );
    expect(result.record!.bytesAfter).toBeLessThan(result.record!.bytesBefore);
  });

  it("returns the original history unchanged when over budget but nothing is compactable", () => {
    const events: StreamEvent[] = [
      { type: "message_start", schemaVersion: 1 },
      { type: "text_delta", schemaVersion: 1, text: "z".repeat(2000) },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ];

    const result = compactHistory(events, { targetBytes: 100 });
    expect(result.events).toBe(events);
    expect(result.record).toBeNull();
  });
});
