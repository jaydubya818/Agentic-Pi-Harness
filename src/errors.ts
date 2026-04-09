export type PiErrorCode =
  | "E_SCHEMA_PARSE"
  | "E_SCHEMA_VERSION"
  | "E_SCHEMA_MISMATCH"
  | "E_POLICY_SIG"
  | "E_HOOK_TIMEOUT"
  | "E_HOOK_EXIT"
  | "E_HOOK_SHELL"
  | "E_TAPE_HASH"
  | "E_TAPE_MIGRATE"
  | "E_CHECKPOINT_WRITE"
  | "E_EFFECT_PRE_HASH"
  | "E_EFFECT_CAPTURE"
  | "E_WORKTREE_ESCAPE"
  | "E_BUDGET_EXCEEDED"
  | "E_TOOL_FORBIDDEN"
  | "E_PROMPT_ASSEMBLY"
  | "E_MODEL_ADAPTER"
  | "E_OTEL_UNAVAILABLE"
  | "E_LOG_UNAVAILABLE"
  | "E_POLICY_CYCLE"
  | "E_UNKNOWN";

export type PiErrorSeverity = "warn" | "error" | "fatal";

export interface PiHarnessErrorOptions {
  severity?: PiErrorSeverity;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

const ERROR_DEFAULTS: Record<PiErrorCode, { severity: PiErrorSeverity; retryable: boolean }> = {
  E_SCHEMA_PARSE: { severity: "error", retryable: false },
  E_SCHEMA_VERSION: { severity: "error", retryable: false },
  E_SCHEMA_MISMATCH: { severity: "error", retryable: false },
  E_POLICY_SIG: { severity: "fatal", retryable: false },
  E_HOOK_TIMEOUT: { severity: "error", retryable: true },
  E_HOOK_EXIT: { severity: "error", retryable: false },
  E_HOOK_SHELL: { severity: "error", retryable: false },
  E_TAPE_HASH: { severity: "error", retryable: false },
  E_TAPE_MIGRATE: { severity: "error", retryable: false },
  E_CHECKPOINT_WRITE: { severity: "fatal", retryable: false },
  E_EFFECT_PRE_HASH: { severity: "error", retryable: false },
  E_EFFECT_CAPTURE: { severity: "error", retryable: false },
  E_WORKTREE_ESCAPE: { severity: "fatal", retryable: false },
  E_BUDGET_EXCEEDED: { severity: "error", retryable: false },
  E_TOOL_FORBIDDEN: { severity: "error", retryable: false },
  E_PROMPT_ASSEMBLY: { severity: "error", retryable: false },
  E_MODEL_ADAPTER: { severity: "error", retryable: true },
  E_OTEL_UNAVAILABLE: { severity: "warn", retryable: false },
  E_LOG_UNAVAILABLE: { severity: "warn", retryable: false },
  E_POLICY_CYCLE: { severity: "error", retryable: false },
  E_UNKNOWN: { severity: "error", retryable: false },
};

export class PiHarnessError extends Error {
  code: PiErrorCode;
  severity: PiErrorSeverity;
  retryable: boolean;
  context: Record<string, unknown>;

  constructor(code: PiErrorCode, message: string, context: Record<string, unknown> = {}, options: Omit<PiHarnessErrorOptions, "context"> = {}) {
    super(message);
    this.name = "PiHarnessError";
    this.code = code;
    this.severity = options.severity ?? ERROR_DEFAULTS[code].severity;
    this.retryable = options.retryable ?? ERROR_DEFAULTS[code].retryable;
    this.context = context;
  }
}
