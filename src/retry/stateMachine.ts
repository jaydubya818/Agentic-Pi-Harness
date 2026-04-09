import { PiHarnessError } from "../errors.js";

export type RetryClassification =
  | "model_open_transient"
  | "model_open_fail_closed"
  | "model_midstream_after_persist"
  | "tool_execution_failure"
  | "persistence_failure"
  | "contract_failure";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryBoundaryState {
  hasPersistedEvent: boolean;
}

export interface NormalizedRetryError {
  code: string | null;
  name: string | null;
  status: number | null;
}

const RETRYABLE_MODEL_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNREFUSED"]);
const RETRYABLE_MODEL_STATUSES = new Set([429, 502, 503, 504]);
const PERSISTENCE_CODES = new Set(["E_TAPE_HASH", "E_CHECKPOINT_WRITE", "E_EFFECT_PRE_HASH", "E_EFFECT_CAPTURE"]);

export function normalizeRetryError(error: unknown): NormalizedRetryError {
  if (!error || typeof error !== "object") {
    return { code: null, name: null, status: null };
  }

  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    name: typeof record.name === "string" ? record.name : null,
    status: typeof record.status === "number" ? record.status : null,
  };
}

export function classifyRetryableModelError(error: unknown, boundary: RetryBoundaryState): RetryClassification {
  if (boundary.hasPersistedEvent) {
    return "model_midstream_after_persist";
  }

  if (error instanceof PiHarnessError) {
    if (error.code.startsWith("E_SCHEMA")) {
      return "contract_failure";
    }
    if (PERSISTENCE_CODES.has(error.code)) {
      return "persistence_failure";
    }
    return "model_open_fail_closed";
  }

  const normalized = normalizeRetryError(error);
  if (
    (normalized.code && RETRYABLE_MODEL_CODES.has(normalized.code)) ||
    (normalized.name && RETRYABLE_MODEL_CODES.has(normalized.name)) ||
    (normalized.status !== null && RETRYABLE_MODEL_STATUSES.has(normalized.status))
  ) {
    return "model_open_transient";
  }

  return "model_open_fail_closed";
}

export function shouldRetryModelInvocation(input: {
  retry?: RetryConfig;
  attempt: number;
  classification: RetryClassification;
}): boolean {
  if (!input.retry) return false;
  return input.classification === "model_open_transient" && input.attempt < input.retry.maxAttempts;
}

export function computeRetryDelayMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  if (attemptIndex <= 0) {
    throw new PiHarnessError("E_UNKNOWN", "retry attemptIndex must be >= 1", { attemptIndex }, { retryable: false });
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attemptIndex - 1));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
