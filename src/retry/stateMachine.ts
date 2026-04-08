import { PiHarnessError } from "../errors.js";

/**
 * Tier B retry state machine. Classifies errors and drives a capped backoff
 * with jitter. States: IDLE → RUNNING → (OK | TRANSIENT_BACKOFF | FATAL).
 */

export type ErrorClass = "transient" | "rate_limit" | "context_overflow" | "fatal";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify: (err: unknown) => ErrorClass;
}

export const defaultClassify = (err: unknown): ErrorClass => {
  const m = (err as Error)?.message ?? "";
  if (/429|rate.?limit/i.test(m)) return "rate_limit";
  if (/context.?length|token.?limit/i.test(m)) return "context_overflow";
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|503|502/i.test(m)) return "transient";
  return "fatal";
};

export async function withRetry<T>(fn: () => Promise<T>, cfg: RetryConfig): Promise<T> {
  let attempt = 0;
  let delay = cfg.baseDelayMs;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const cls = cfg.classify(err);
      if (cls === "fatal" || attempt >= cfg.maxAttempts) {
        throw new PiHarnessError("E_MODEL_ADAPTER", `retry exhausted: ${(err as Error).message}`, { attempt, class: cls });
      }
      if (cls === "context_overflow") {
        // caller's responsibility to compact; bubble a distinct error
        throw new PiHarnessError("E_BUDGET_EXCEEDED", "context overflow — compaction required", { attempt });
      }
      const jitter = Math.floor(Math.random() * delay * 0.25);
      await sleep(delay + jitter);
      delay = Math.min(cfg.maxDelayMs, delay * 2);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
