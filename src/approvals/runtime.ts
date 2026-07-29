import { PolicyDecision } from "../schemas/index.js";

export interface ApprovalPacket {
  packetId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  requestedAt: string;
  approvalRequiredBy: NonNullable<PolicyDecision["approvalRequiredBy"]>;
  timeoutMs: number;
  reason: string;
}

export interface ApprovalResponse {
  outcome: "approve" | "deny";
  actor?: string;
  reason?: string;
}

export interface ApprovalDecision {
  packetId: string;
  toolCallId: string;
  outcome: "approve" | "deny" | "timeout";
  actor: string;
  reason?: string;
  decidedAt: string;
}

export interface ApprovalRequester {
  request(packet: ApprovalPacket, signal: AbortSignal): Promise<ApprovalResponse>;
}

export function approvalRequiredByForDecision(decision: PolicyDecision): NonNullable<PolicyDecision["approvalRequiredBy"]> {
  if (decision.winningRuleId) return "rule";
  return "mode";
}

export function createApprovalPacket(input: {
  sessionId: string;
  decision: PolicyDecision;
  toolName: string;
  timeoutMs: number;
  requestedAt?: string;
}): ApprovalPacket {
  return {
    packetId: `${input.decision.toolCallId}:approval`,
    sessionId: input.sessionId,
    toolCallId: input.decision.toolCallId,
    toolName: input.toolName,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    approvalRequiredBy: approvalRequiredByForDecision(input.decision),
    timeoutMs: input.timeoutMs,
    reason: input.decision.winningRuleId
      ? `approval required by rule ${input.decision.winningRuleId}`
      : `approval required by mode ${input.decision.modeInfluence}`,
  };
}

export async function requestApprovalDecision(input: {
  packet: ApprovalPacket;
  requester?: ApprovalRequester;
  timeoutMs: number;
  signal?: AbortSignal;
  decidedAt?: () => string;
}): Promise<ApprovalDecision> {
  const decidedAt = input.decidedAt ?? (() => new Date().toISOString());
  if (!input.requester) {
    return {
      packetId: input.packet.packetId,
      toolCallId: input.packet.toolCallId,
      outcome: "timeout",
      actor: "system",
      reason: "no approval requester configured",
      decidedAt: decidedAt(),
    };
  }

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timedOut = Symbol("approval-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    let raced: ApprovalResponse | typeof timedOut;
    const requester = input.requester;
    // The async wrapper converts a synchronously-throwing requester into a
    // rejection so it still fails closed via the catch below.
    const requestPromise = (async () => requester.request(input.packet, abortController.signal))();
    // A requester that rejects *after* losing the race (e.g. it throws in
    // response to the abort we send on timeout) must not surface as an
    // unhandled rejection; the timeout outcome below already covers it.
    requestPromise.catch(() => { /* handled via race or timeout outcome */ });
    try {
      raced = await Promise.race([
        requestPromise,
        new Promise<typeof timedOut>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timedOut), input.timeoutMs);
        }),
      ]);
    } catch (error) {
      // A crashing approval requester must fail closed to deny — not
      // propagate and abort the whole run over a broken approval channel.
      abortController.abort();
      return {
        packetId: input.packet.packetId,
        toolCallId: input.packet.toolCallId,
        outcome: "deny",
        actor: "system",
        reason: `approval requester failed: ${error instanceof Error ? error.message : String(error)}`,
        decidedAt: decidedAt(),
      };
    }

    if (raced === timedOut) {
      abortController.abort();
      return {
        packetId: input.packet.packetId,
        toolCallId: input.packet.toolCallId,
        outcome: "timeout",
        actor: "system",
        reason: "approval timeout",
        decidedAt: decidedAt(),
      };
    }

    return {
      packetId: input.packet.packetId,
      toolCallId: input.packet.toolCallId,
      outcome: raced.outcome,
      actor: raced.actor ?? "human",
      reason: raced.reason,
      decidedAt: decidedAt(),
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export function applyApprovalDecision(decision: PolicyDecision, approval: ApprovalDecision): PolicyDecision {
  const result = approval.outcome === "approve" ? "approve" : "deny";
  const ruleEvaluation = decision.ruleEvaluation.map((entry) => {
    if (entry.ruleId !== decision.winningRuleId) return entry;
    return {
      ...entry,
      effect: result === "approve" ? "allow" as const : "deny" as const,
    };
  });

  return {
    ...decision,
    result,
    ruleEvaluation,
    approvalRequiredBy: approvalRequiredByForDecision(decision),
  };
}
