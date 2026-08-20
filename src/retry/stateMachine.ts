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

const RETRYABLE_MODEL_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  // undici's spellings of the same transport failures. Any fetch-based
  // provider on Node 18+ reports connect/header timeouts and dropped
  // sockets under these codes rather than the libuv ones above.
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/**
 * 408 is the standard "the server gave up waiting for this request"; 529 is
 * the Anthropic API's documented `overloaded_error`, which is the capacity
 * signal a Claude-backed provider returns most often and is explicitly meant
 * to be retried. Both previously classified as `model_open_fail_closed` and
 * ended the run on the first occurrence. 500 stays out: it is not
 * distinguishable from a deterministic server-side rejection, so retrying it
 * risks replaying a request the provider has already refused on its merits.
 */
const RETRYABLE_MODEL_STATUSES = new Set([408, 429, 502, 503, 504, 529]);
const PERSISTENCE_CODES = new Set(["E_TAPE_HASH", "E_CHECKPOINT_WRITE", "E_EFFECT_PRE_HASH", "E_EFFECT_CAPTURE"]);

/**
 * How far to walk the `cause` chain looking for the real transport error.
 * undici nests one level (`TypeError: fetch failed` -> the socket error);
 * SDKs that re-wrap it add one or two more. Bounded so a self-referential
 * or adversarially deep chain cannot spin here.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * Reads code/name/status off the error, falling back through its `cause`
 * chain for any field the outermost error does not carry.
 *
 * This matters because every fetch-based provider on Node 18+ surfaces
 * transport failures as `TypeError: fetch failed` with the actual
 * ECONNRESET / ETIMEDOUT / UND_ERR_* error hung off `cause`. Reading only
 * the top level saw `{ code: null, name: "TypeError", status: null }`, so
 * the single most common transient failure in production classified as
 * `model_open_fail_closed` and was never retried -- the retry state machine
 * effectively only fired for hand-rolled providers that set `code` directly.
 */
export function normalizeRetryError(error: unknown): NormalizedRetryError {
  const normalized: NormalizedRetryError = { code: null, name: null, status: null };
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (normalized.code === null && typeof record.code === "string") normalized.code = record.code;
    if (normalized.name === null && typeof record.name === "string") normalized.name = record.name;
    if (normalized.status === null && typeof record.status === "number") normalized.status = record.status;
    if (normalized.code !== null && normalized.name !== null && normalized.status !== null) break;
    current = record.cause;
  }

  return normalized;
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
