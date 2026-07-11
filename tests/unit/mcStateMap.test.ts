import { describe, expect, it } from "vitest";
import {
  artifactKey,
  claimKey,
  expectedWorkOrderState,
  isMcBridgeExecutionState,
  isTerminalMcBridgeState,
  MC_BRIDGE_EXECUTION_STATES,
  MC_VERIFICATION_STATUSES,
  runKey,
  stateKey,
  verificationKey,
  type McBridgeExecutionState,
  type McVerificationStatus,
  type McWorkOrderState,
} from "../../src/mc/stateMap.js";

describe("expectedWorkOrderState — exhaustive mirror of MC executorContract", () => {
  it("covers every bridge state x verification status (fails when a state is unmapped)", () => {
    expect(MC_BRIDGE_EXECUTION_STATES).toHaveLength(9);
    for (const bridgeState of MC_BRIDGE_EXECUTION_STATES) {
      for (const verificationStatus of MC_VERIFICATION_STATUSES) {
        const result = expectedWorkOrderState(bridgeState, verificationStatus);
        expect(result, `${bridgeState}/${verificationStatus}`).toBeTruthy();
      }
    }
  });

  const nonSucceededExpectations: Array<[McBridgeExecutionState, McWorkOrderState]> = [
    ["accepted", "DISPATCHED"],
    ["starting", "DISPATCHED"],
    ["running", "IN_PROGRESS"],
    ["producing_artifacts", "IN_PROGRESS"],
    ["failed", "BLOCKED"],
    ["timed_out", "BLOCKED"],
    ["interrupted", "BLOCKED"],
    ["cancelled", "CANCELED"],
  ];

  it.each(nonSucceededExpectations)("%s → %s regardless of verification status", (bridgeState, expected) => {
    for (const verificationStatus of MC_VERIFICATION_STATUSES) {
      expect(expectedWorkOrderState(bridgeState, verificationStatus)).toBe(expected);
    }
  });

  it.each([
    ["PENDING", "AWAITING_VERIFICATION"],
    ["FAIL", "AWAITING_VERIFICATION"],
    ["PASS", "DONE"],
    ["WAIVED", "DONE"],
  ] as Array<[McVerificationStatus, McWorkOrderState]>)(
    "succeeded with verification %s → %s",
    (verificationStatus, expected) => {
      expect(expectedWorkOrderState("succeeded", verificationStatus)).toBe(expected);
    },
  );

  it("never returns DONE unless verification passed or was waived", () => {
    for (const bridgeState of MC_BRIDGE_EXECUTION_STATES) {
      for (const verificationStatus of ["PENDING", "FAIL"] as McVerificationStatus[]) {
        expect(expectedWorkOrderState(bridgeState, verificationStatus)).not.toBe("DONE");
      }
    }
  });
});

describe("bridge state guards", () => {
  it("isMcBridgeExecutionState accepts all nine states and rejects others", () => {
    for (const state of MC_BRIDGE_EXECUTION_STATES) {
      expect(isMcBridgeExecutionState(state)).toBe(true);
    }
    expect(isMcBridgeExecutionState("queued")).toBe(false);
    expect(isMcBridgeExecutionState("waiting_approval")).toBe(false);
    expect(isMcBridgeExecutionState("blocked")).toBe(false);
    expect(isMcBridgeExecutionState("")).toBe(false);
  });

  it("terminal detection matches the MC contract", () => {
    expect(isTerminalMcBridgeState("succeeded")).toBe(true);
    expect(isTerminalMcBridgeState("failed")).toBe(true);
    expect(isTerminalMcBridgeState("timed_out")).toBe(true);
    expect(isTerminalMcBridgeState("interrupted")).toBe(true);
    expect(isTerminalMcBridgeState("cancelled")).toBe(true);
    expect(isTerminalMcBridgeState("accepted")).toBe(false);
    expect(isTerminalMcBridgeState("starting")).toBe(false);
    expect(isTerminalMcBridgeState("running")).toBe(false);
    expect(isTerminalMcBridgeState("producing_artifacts")).toBe(false);
  });
});

describe("idempotency key builders", () => {
  it("are deterministic (same inputs, same key)", () => {
    expect(claimKey("wo1", 2)).toBe(claimKey("wo1", 2));
    expect(stateKey("wo1", "run1", 3)).toBe(stateKey("wo1", "run1", 3));
    expect(runKey("wo1", "run1")).toBe(runKey("wo1", "run1"));
    expect(artifactKey("wo1", "a1")).toBe(artifactKey("wo1", "a1"));
    expect(verificationKey("wo1", "c1", "run1")).toBe(verificationKey("wo1", "c1", "run1"));
  });

  it("match the MC key formats exactly", () => {
    expect(claimKey("wo1", 2)).toBe("pib:claim:wo1:2");
    expect(stateKey("wo1", "run1", 3)).toBe("pib:state:wo1:run1:3");
    expect(runKey("wo1", "run1")).toBe("pib:run:wo1:run1");
    expect(artifactKey("wo1", "a1")).toBe("pib:art:wo1:a1");
    expect(verificationKey("wo1", "c1", "run1")).toBe("pib:verify:wo1:c1:run1");
  });

  it("all use the pib prefix", () => {
    const keys = [
      claimKey("w", 1),
      stateKey("w", "r", 1),
      runKey("w", "r"),
      artifactKey("w", "a"),
      verificationKey("w", "c", "r"),
    ];
    for (const key of keys) expect(key.startsWith("pib:")).toBe(true);
  });

  it("differ across inputs (uniqueness)", () => {
    const keys = [
      claimKey("wo1", 1),
      claimKey("wo1", 2),
      claimKey("wo2", 1),
      stateKey("wo1", "run1", 1),
      stateKey("wo1", "run1", 2),
      stateKey("wo1", "run2", 1),
      runKey("wo1", "run1"),
      runKey("wo1", "run2"),
      artifactKey("wo1", "a1"),
      artifactKey("wo1", "a2"),
      verificationKey("wo1", "c1", "run1"),
      verificationKey("wo1", "c2", "run1"),
      verificationKey("wo1", "c1", "run2"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("contain no timestamps (stable across time)", () => {
    const before = stateKey("wo1", "run1", 1);
    const after = stateKey("wo1", "run1", 1);
    expect(before).toBe(after);
    expect(before).not.toMatch(/\d{10,}/);
  });
});
