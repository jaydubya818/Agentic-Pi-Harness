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
  try {
    const response = await Promise.race([
      input.requester.request(input.packet, abortController.signal),
      new Promise<ApprovalResponse>((resolve) => setTimeout(() => resolve({ outcome: "deny", actor: "system", reason: "approval timeout" }), input.timeoutMs)),
    ]);

    if (response.outcome === "deny" && response.reason === "approval timeout") {
      return {
        packetId: input.packet.packetId,
        toolCallId: input.packet.toolCallId,
        outcome: "timeout",
        actor: response.actor ?? "system",
        reason: response.reason,
        decidedAt: decidedAt(),
      };
    }

    return {
      packetId: input.packet.packetId,
      toolCallId: input.packet.toolCallId,
      outcome: response.outcome,
      actor: response.actor ?? "human",
      reason: response.reason,
      decidedAt: decidedAt(),
    };
  } finally {
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
