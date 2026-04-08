import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * Tier B hook dispatcher — in-process module hooks only.
 * Shell and HTTP hook contracts are specified in docs/HOOK-SECURITY.md but
 * not executed here. Worker mode only allows in-process hooks anyway.
 */

export type HookEvent =
  | "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
  | "PreCompact" | "Stop" | "SubagentStop";

export const HookResponseSchema = z.object({
  outcome: z.enum(["continue", "deny", "modify"]),
  reason: z.string().optional(),
  patch: z.unknown().optional(),
});
export type HookResponse = z.infer<typeof HookResponseSchema>;

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  turnIndex: number;
  payload: unknown;
}

export type InProcessHook = (ctx: HookContext) => Promise<HookResponse> | HookResponse;

export interface RegisteredHook {
  pluginId: string;
  event: HookEvent;
  fn: InProcessHook;
  timeoutMs: number;
}

export interface HookAuditRecord {
  schemaVersion: 1;
  event: HookEvent;
  pluginId: string;
  hookType: "module";
  durationMs: number;
  exitCode: 0 | 1;
  responseDigest: string;
}

export class HookDispatcher {
  private hooks: RegisteredHook[] = [];
  register(h: RegisteredHook): void { this.hooks.push(h); }

  async dispatch(ctx: HookContext): Promise<{ responses: HookResponse[]; audits: HookAuditRecord[] }> {
    const responses: HookResponse[] = [];
    const audits: HookAuditRecord[] = [];
    for (const h of this.hooks) {
      if (h.event !== ctx.event) continue;
      const started = Date.now();
      try {
        const res = await withTimeout(Promise.resolve(h.fn(ctx)), h.timeoutMs);
        const parsed = HookResponseSchema.parse(res);
        responses.push(parsed);
        audits.push({
          schemaVersion: 1,
          event: ctx.event, pluginId: h.pluginId, hookType: "module",
          durationMs: Date.now() - started, exitCode: 0,
          responseDigest: digest(parsed),
        });
        if (parsed.outcome === "deny") break;
      } catch (e) {
        audits.push({
          schemaVersion: 1,
          event: ctx.event, pluginId: h.pluginId, hookType: "module",
          durationMs: Date.now() - started, exitCode: 1,
          responseDigest: "sha256:error",
        });
      }
    }
    return { responses, audits };
  }
}

function digest(v: unknown): string {
  // lightweight — full canonicalization not required for audit digest
  return "sha256:" + createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("hook timeout")), ms)),
  ]);
}
