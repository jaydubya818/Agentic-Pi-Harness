import { z } from "zod";
import { PolicyDecision } from "../schemas/index.js";

export type ToolHookEvent = "PreToolUse" | "PostToolUse";

const ToolHookContinueSchema = z.object({
  outcome: z.literal("continue"),
  reason: z.string().optional(),
});

const ToolHookDenySchema = z.object({
  outcome: z.literal("deny"),
  reason: z.string().optional(),
});

const ToolHookResponseSchema = z.union([ToolHookContinueSchema, ToolHookDenySchema]);
export type ToolHookResponse = z.infer<typeof ToolHookResponseSchema>;

export interface HookDecisionSummary {
  hookId: string;
  decision: "deny";
  reason?: string;
}

export interface PreToolHookContext {
  event: "PreToolUse";
  sessionId: string;
  turnIndex: number;
  payload: {
    toolCallId: string;
    toolName: string;
    mode: PolicyDecision["modeInfluence"];
    input: unknown;
    baseDecision: {
      result: PolicyDecision["result"];
      provenanceMode: PolicyDecision["provenanceMode"];
      winningRuleId: PolicyDecision["winningRuleId"];
    };
  };
}

export interface PostToolHookContext {
  event: "PostToolUse";
  sessionId: string;
  turnIndex: number;
  payload: {
    toolCallId: string;
    toolName: string;
    mode: PolicyDecision["modeInfluence"];
    input: unknown;
    isError: boolean;
    paths: string[];
  };
}

export type ToolHookContext = PreToolHookContext | PostToolHookContext;
export type ToolHookFunction = (context: ToolHookContext) => Promise<unknown> | unknown;

export interface RegisteredToolHook {
  hookId: string;
  event: ToolHookEvent;
  timeoutMs: number;
  fn: ToolHookFunction;
}

export interface ToolHookRunSummary {
  hookId: string;
  event: ToolHookEvent;
  status: "continue" | "deny" | "invalid" | "error";
  reason?: string;
}

export interface PreToolHookDispatchResult {
  summaries: ToolHookRunSummary[];
  deniedBy: HookDecisionSummary | null;
}

export interface PostToolHookDispatchResult {
  summaries: ToolHookRunSummary[];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`hook timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

function validateResponseForEvent(event: ToolHookEvent, value: unknown): ToolHookResponse | null {
  const parsed = ToolHookResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  if (event === "PostToolUse" && parsed.data.outcome !== "continue") return null;
  return parsed.data;
}

export async function dispatchPreToolHooks(
  hooks: RegisteredToolHook[],
  context: PreToolHookContext,
): Promise<PreToolHookDispatchResult> {
  const summaries: ToolHookRunSummary[] = [];

  for (const hook of hooks) {
    if (hook.event !== "PreToolUse") continue;
    try {
      const raw = await withTimeout(Promise.resolve(hook.fn(context)), hook.timeoutMs);
      const response = validateResponseForEvent("PreToolUse", raw);
      if (!response) {
        summaries.push({ hookId: hook.hookId, event: hook.event, status: "invalid" });
        continue;
      }
      if (response.outcome === "deny") {
        summaries.push({ hookId: hook.hookId, event: hook.event, status: "deny", reason: response.reason });
        return {
          summaries,
          deniedBy: { hookId: hook.hookId, decision: "deny", reason: response.reason },
        };
      }
      summaries.push({ hookId: hook.hookId, event: hook.event, status: "continue", reason: response.reason });
    } catch (error) {
      summaries.push({
        hookId: hook.hookId,
        event: hook.event,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { summaries, deniedBy: null };
}

export async function dispatchPostToolHooks(
  hooks: RegisteredToolHook[],
  context: PostToolHookContext,
): Promise<PostToolHookDispatchResult> {
  const summaries: ToolHookRunSummary[] = [];

  for (const hook of hooks) {
    if (hook.event !== "PostToolUse") continue;
    try {
      const raw = await withTimeout(Promise.resolve(hook.fn(context)), hook.timeoutMs);
      const response = validateResponseForEvent("PostToolUse", raw);
      if (!response) {
        summaries.push({ hookId: hook.hookId, event: hook.event, status: "invalid" });
        continue;
      }
      summaries.push({ hookId: hook.hookId, event: hook.event, status: "continue", reason: response.reason });
    } catch (error) {
      summaries.push({
        hookId: hook.hookId,
        event: hook.event,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { summaries };
}

export function mergeHookDeniedDecision(baseDecision: PolicyDecision, deniedBy: HookDecisionSummary): PolicyDecision {
  return {
    ...baseDecision,
    result: "deny",
    hookDecision: deniedBy,
    mutatedByHook: false,
    approvalRequiredBy: null,
  };
}
