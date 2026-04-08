import { PiProviderLike, PiStreamChunk } from "./pi-client.js";
import { PiHarnessError } from "../errors.js";

/**
 * Real pi.dev provider. Lazily imports the `pi` package so the harness can
 * build and test without pulling the dependency. To activate:
 *
 *   npm install pi
 *   new PiDevProvider({ provider: "anthropic", model: "claude-sonnet-4-6" })
 *
 * This file is deliberately thin — it is the only place that knows pi.dev's
 * concrete API shape. Everything above Layer 1 consumes the normalized
 * `PiStreamChunk` from `pi-client.ts`.
 */

export interface PiDevOptions {
  provider: string;               // "anthropic" | "openai" | ...
  model: string;
  apiKey?: string;                // falls back to provider-specific env var
}

interface PiModule {
  createClient(opts: { provider: string; model: string; apiKey?: string }): {
    stream(messages: unknown[]): AsyncIterable<unknown>;
  };
}

export class PiDevProvider implements PiProviderLike {
  name: string;
  private client: { stream(messages: unknown[]): AsyncIterable<unknown> } | null = null;

  constructor(private opts: PiDevOptions) {
    this.name = `pi.dev:${opts.provider}:${opts.model}`;
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    let mod: PiModule;
    try {
      // @ts-ignore - optional dependency
      mod = (await import("pi")) as unknown as PiModule;
    } catch (e) {
      throw new PiHarnessError(
        "E_MODEL_ADAPTER",
        "pi.dev package not installed. Run `npm install pi` to enable PiDevProvider.",
        { cause: String(e) },
      );
    }
    this.client = mod.createClient({
      provider: this.opts.provider,
      model: this.opts.model,
      apiKey: this.opts.apiKey,
    });
  }

  async *stream(messages: unknown[]): AsyncIterable<PiStreamChunk> {
    await this.ensureClient();
    for await (const raw of this.client!.stream(messages)) {
      yield normalize(raw);
    }
  }
}

/**
 * Convert pi.dev's shape into PiStreamChunk. Pi.dev emits objects like:
 *   { type: "message_start" }
 *   { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
 *   { type: "content_block_start", content_block: { type: "tool_use", id, name, input } }
 *   { type: "message_stop", stopReason }
 * This mapping is the brittle seam; when pi.dev's shape shifts, only this
 * function changes.
 */
export function normalize(raw: unknown): PiStreamChunk {
  const r = raw as Record<string, unknown>;
  const t = r?.type as string | undefined;
  switch (t) {
    case "message_start":
      return { kind: "start" };
    case "content_block_delta": {
      const delta = (r.delta as Record<string, unknown>) ?? {};
      if (delta.type === "text_delta") return { kind: "text", text: String(delta.text ?? "") };
      return { kind: "text", text: "" };
    }
    case "content_block_start": {
      const cb = (r.content_block as Record<string, unknown>) ?? {};
      if (cb.type === "tool_use") {
        return {
          kind: "tool_call",
          toolCallId: String(cb.id ?? ""),
          toolName: String(cb.name ?? ""),
          input: cb.input ?? {},
        };
      }
      return { kind: "text", text: "" };
    }
    case "tool_result":
      return {
        kind: "tool_result",
        toolCallId: String(r.toolCallId ?? r.id ?? ""),
        output: String(r.output ?? ""),
        isError: Boolean(r.isError),
      };
    case "message_stop":
      return { kind: "stop", stopReason: String(r.stopReason ?? r.stop_reason ?? "end_turn") };
    default:
      throw new PiHarnessError("E_MODEL_ADAPTER", `unrecognized pi.dev chunk type: ${t}`);
  }
}
