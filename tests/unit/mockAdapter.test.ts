import { describe, expect, it } from "vitest";
import {
  createGoldenPathMockModelClient,
  createGoldenPathScript,
  MockModelClient,
} from "../../src/adapter/pi-adapter.js";
import { StreamEvent } from "../../src/schemas/index.js";

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("mock adapter", () => {
  it("creates the canonical golden-path script", () => {
    const script = createGoldenPathScript({ targetPath: "/tmp/tests/math.test.ts" });
    expect(script).toEqual([
      { type: "message_start", schemaVersion: 1 },
      { type: "text_delta", schemaVersion: 1, text: "Reading failing test." },
      { type: "tool_use", schemaVersion: 1, id: "t1", name: "read_file", input: { path: "/tmp/tests/math.test.ts" } },
      { type: "text_delta", schemaVersion: 1, text: "Patching." },
      {
        type: "tool_use",
        schemaVersion: 1,
        id: "t2",
        name: "write_file",
        input: { path: "/tmp/tests/math.test.ts", content: "test('adds', () => { expect(1 + 1).toBe(2); });\n" },
      },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ]);
  });

  it("yields deterministic replay-friendly events across repeated streams", async () => {
    const client = createGoldenPathMockModelClient({ targetPath: "/tmp/tests/math.test.ts" });

    const first = await collect(client.stream([{ role: "user", content: "fix it" }]));
    const second = await collect(client.stream([{ role: "user", content: "ignored" }]));

    expect(second).toEqual(first);
  });

  it("clones events so caller mutation does not affect later streams", async () => {
    const baseScript = createGoldenPathScript({ targetPath: "/tmp/tests/math.test.ts" });
    const client = new MockModelClient(baseScript);

    const first = await collect(client.stream([]));
    (first[1] as Extract<StreamEvent, { type: "text_delta" }>).text = "mutated";

    const second = await collect(client.stream([]));
    expect((second[1] as Extract<StreamEvent, { type: "text_delta" }>).text).toBe("Reading failing test.");
  });
});
