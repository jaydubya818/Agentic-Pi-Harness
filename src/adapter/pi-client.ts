import { ModelClient } from "./pi-adapter.js";
import { StreamEvent } from "../schemas/index.js";
import { PiHarnessError } from "../errors.js";

/**
 * pi.dev adapter seam. Pi.dev's runtime exposes a provider-agnostic streaming
 * API; we convert its chunks into our StreamEvent schema so the rest of the
 * harness never sees provider-specific shapes.
 *
 * This is a seam: the `PiProviderLike` interface lets us swap in a real
 * pi.dev client, an Anthropic SDK client, or a fake for tests. The real
 * pi.dev import is deliberately lazy so the harness can build and test
 * without pulling the dependency.
 */

export interface PiStreamChunk {
  kind: "text" | "tool_call" | "tool_result" | "start" | "stop";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  stopReason?: string;
}

export interface PiProviderLike {
  name: string;
  stream(messages: unknown[]): AsyncIterable<PiStreamChunk>;
}

export class PiAdapterClient implements ModelClient {
  constructor(public provider: PiProviderLike) {}
  get name(): string { return this.provider.name; }

  async *stream(messages: unknown[]): AsyncIterable<StreamEvent> {
    for await (const c of this.provider.stream(messages)) {
      yield this.convert(c);
    }
  }

  private convert(c: PiStreamChunk): StreamEvent {
    switch (c.kind) {
      case "start": return { type: "message_start", schemaVersion: 1 };
      case "text":
        if (c.text == null) throw new PiHarnessError("E_MODEL_ADAPTER", "text chunk missing text");
        return { type: "text_delta", schemaVersion: 1, text: c.text };
      case "tool_call":
        if (!c.toolCallId || !c.toolName) throw new PiHarnessError("E_MODEL_ADAPTER", "tool_call missing id/name");
        return { type: "tool_use", schemaVersion: 1, id: c.toolCallId, name: c.toolName, input: c.input ?? {} };
      case "tool_result":
        if (!c.toolCallId) throw new PiHarnessError("E_MODEL_ADAPTER", "tool_result missing id");
        return { type: "tool_result", schemaVersion: 1, id: c.toolCallId, output: c.output ?? "", isError: !!c.isError };
      case "stop":
        return { type: "message_stop", schemaVersion: 1, stopReason: c.stopReason ?? "end_turn" };
      default:
        throw new PiHarnessError("E_MODEL_ADAPTER", `unknown chunk kind: ${(c as PiStreamChunk).kind}`);
    }
  }
}
