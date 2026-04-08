import { describe, it, expect } from "vitest";
import { PiAdapterClient, PiStreamChunk, PiProviderLike } from "../../src/adapter/pi-client.js";
import { StreamEvent } from "../../src/schemas/index.js";

class FakeProvider implements PiProviderLike {
  name = "fake";
  constructor(private chunks: PiStreamChunk[]) {}
  async *stream(): AsyncIterable<PiStreamChunk> { for (const c of this.chunks) yield c; }
}

describe("PiAdapterClient", () => {
  it("converts chunks to StreamEvents", async () => {
    const p = new FakeProvider([
      { kind: "start" },
      { kind: "text", text: "hi" },
      { kind: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "x" } },
      { kind: "tool_result", toolCallId: "t1", output: "ok", isError: false },
      { kind: "stop", stopReason: "end_turn" },
    ]);
    const client = new PiAdapterClient(p);
    const out: StreamEvent[] = [];
    for await (const e of client.stream([])) out.push(e);
    expect(out.map((e) => e.type)).toEqual(["message_start", "text_delta", "tool_use", "tool_result", "message_stop"]);
  });

  it("throws on malformed chunk", async () => {
    const p = new FakeProvider([{ kind: "tool_call" } as any]);
    const client = new PiAdapterClient(p);
    await expect((async () => { for await (const _ of client.stream([])) {} })()).rejects.toThrow();
  });
});
