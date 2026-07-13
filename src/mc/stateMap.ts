/**
 * Mission Control executor contract — Pi-side mirror.
 *
 * This module MIRRORS Mission Control's `convex/lib/executorContract.ts`
 * (branch sf/21a-executor-contract). Authority model: Mission Control owns
 * state, verification, and audit. The bridge state machine here can never
 * assert DONE — a successful execution maps to AWAITING_VERIFICATION unless
 * Mission Control's own verification status is already PASS/WAIVED.
 *
 * Update BOTH repositories when a state is added. The exhaustive test in
 * tests/unit/mcStateMap.test.ts fails when a state is unmapped.
 */

/** Execution states emitted by the Pi bridge state machine (MC contract order). */
export const MC_BRIDGE_EXECUTION_STATES = [
  "accepted",
  "starting",
  "running",
  "producing_artifacts",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
] as const;

export type McBridgeExecutionState = (typeof MC_BRIDGE_EXECUTION_STATES)[number];

export type McVerificationStatus = "PENDING" | "PASS" | "FAIL" | "WAIVED";

export const MC_VERIFICATION_STATUSES: readonly McVerificationStatus[] = [
  "PENDING",
  "PASS",
  "FAIL",
  "WAIVED",
];

/** Work-order states an executor report can land on (subset of MC's machine). */
export type McWorkOrderState =
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "AWAITING_VERIFICATION"
  | "DONE"
  | "BLOCKED"
  | "CANCELED";

export function isMcBridgeExecutionState(value: string): value is McBridgeExecutionState {
  return (MC_BRIDGE_EXECUTION_STATES as readonly string[]).includes(value);
}

export function isTerminalMcBridgeState(state: McBridgeExecutionState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "timed_out"
    || state === "interrupted"
    || state === "cancelled";
}

/**
 * The work-order state Mission Control is expected to return for a reported
 * bridge state. Mirror of MC's mapBridgeState + nextStateForRunStatus rule:
 * succeeded → DONE only when MC's verification status is already PASS/WAIVED,
 * otherwise AWAITING_VERIFICATION. Used to detect drift between the two
 * repositories — never to set state locally.
 */
export function expectedWorkOrderState(
  bridgeState: McBridgeExecutionState,
  verificationStatus: McVerificationStatus,
): McWorkOrderState {
  switch (bridgeState) {
    case "accepted":
    case "starting":
      return "DISPATCHED";
    case "running":
    case "producing_artifacts":
      return "IN_PROGRESS";
    case "succeeded":
      return verificationStatus === "PASS" || verificationStatus === "WAIVED"
        ? "DONE"
        : "AWAITING_VERIFICATION";
    case "failed":
    case "timed_out":
    case "interrupted":
      return "BLOCKED";
    case "cancelled":
      return "CANCELED";
  }
}

// ── Idempotency keys ────────────────────────────────────────────────────────
// Deterministic, timestamp-free mirrors of MC's builders. Prefix "pib"
// namespaces the Pi bridge; replays are absorbed by MC's by_idempotency
// indexes.

export function claimKey(workOrderId: string, attempt: number): string {
  return `pib:claim:${workOrderId}:${attempt}`;
}

export function stateKey(workOrderId: string, bridgeRunId: string, seq: number): string {
  return `pib:state:${workOrderId}:${bridgeRunId}:${seq}`;
}

export function runKey(workOrderId: string, bridgeRunId: string): string {
  return `pib:run:${workOrderId}:${bridgeRunId}`;
}

export function artifactKey(workOrderId: string, artifactId: string): string {
  return `pib:art:${workOrderId}:${artifactId}`;
}

export function verificationKey(
  workOrderId: string,
  criterionId: string,
  bridgeRunId: string,
): string {
  return `pib:verify:${workOrderId}:${criterionId}:${bridgeRunId}`;
}
