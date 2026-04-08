import { StreamEvent } from "../schemas/index.js";

export interface CostTable {
  version: string;
  provider: string;
  model: string;
  /** USD per 1k input tokens */
  inputPer1k: number;
  /** USD per 1k output tokens */
  outputPer1k: number;
}

export interface CostRecord {
  schemaVersion: 1;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  at: string;
}

/** Rough char->token estimate (4 chars per token is the industry heuristic). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Accumulates input/output token estimates across a stream. The harness does
 * not see raw model usage (pi.dev may or may not emit it), so we track the
 * visible text deltas as output and the tool-result bodies as input-next-turn.
 */
export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  constructor(private table: CostTable) {}

  observe(e: StreamEvent): void {
    if (e.type === "text_delta") this.outputTokens += estimateTokens(e.text);
    else if (e.type === "tool_result") this.inputTokens += estimateTokens(e.output);
  }

  snapshot(): CostRecord {
    const usd =
      (this.inputTokens / 1000) * this.table.inputPer1k +
      (this.outputTokens / 1000) * this.table.outputPer1k;
    return {
      schemaVersion: 1,
      provider: this.table.provider,
      model: this.table.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      usd: Math.round(usd * 1e6) / 1e6, // 6 decimal places
      at: new Date().toISOString(),
    };
  }
}

export const DEFAULT_COST_TABLE: CostTable = {
  version: "2026-04-01",
  provider: "mock",
  model: "mock",
  inputPer1k: 0,
  outputPer1k: 0,
};
