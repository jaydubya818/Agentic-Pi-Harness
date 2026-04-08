export type PiErrorCode =
  | "E_SCHEMA_PARSE"
  | "E_SCHEMA_VERSION"
  | "E_POLICY_SIG"
  | "E_HOOK_TIMEOUT"
  | "E_HOOK_EXIT"
  | "E_TAPE_HASH"
  | "E_TAPE_MIGRATE"
  | "E_CHECKPOINT_WRITE"
  | "E_EFFECT_PRE_HASH"
  | "E_WORKTREE_ESCAPE"
  | "E_BUDGET_EXCEEDED"
  | "E_TOOL_FORBIDDEN"
  | "E_PROMPT_ASSEMBLY"
  | "E_MODEL_ADAPTER"
  | "E_OTEL_UNAVAILABLE"
  | "E_LOG_UNAVAILABLE"
  | "E_UNKNOWN";

export class PiHarnessError extends Error {
  code: PiErrorCode;
  context: Record<string, unknown>;
  constructor(code: PiErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "PiHarnessError";
    this.code = code;
    this.context = context;
  }
}
