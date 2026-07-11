import { describe, expect, it, vi } from "vitest";
import { McClient, McClientError, type McConvexTransport } from "../../src/mc/client.js";

function mockTransport(overrides: Partial<McConvexTransport> = {}): McConvexTransport {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutation: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe("McClient retry semantics", () => {
  it("retries once on a network error and succeeds", async () => {
    const mutation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ claimed: true, replay: false });
    const client = new McClient(mockTransport({ mutation }), { retryBackoffMs: 1, logger: { warn: () => undefined } });

    const result = await client.claimForExecutor({
      workOrderId: "wo1",
      agentId: "a1",
      executionId: "pi-wo1-1",
      idempotencyKey: "pib:claim:wo1:1",
    });
    expect(result.claimed).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it("does not retry function-thrown errors", async () => {
    const functionError = new Error("WorkOrder is not claimed by this executor");
    const mutation = vi.fn().mockRejectedValue(functionError);
    const client = new McClient(mockTransport({ mutation }), { retryBackoffMs: 1, logger: { warn: () => undefined } });

    await expect(
      client.reportExecutionEvent({
        workOrderId: "wo1",
        agentId: "a1",
        bridgeState: "running",
        seq: 1,
        bridgeRunId: "run1",
        idempotencyKey: "pib:state:wo1:run1:1",
      }),
    ).rejects.toBe(functionError);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("fails with a sanitized error after the single retry is exhausted", async () => {
    const warnings: string[] = [];
    const mutation = vi.fn().mockRejectedValue(new Error("fetch failed: https://secret-deploy.convex.cloud/api"));
    const client = new McClient(mockTransport({ mutation }), {
      retryBackoffMs: 1,
      logger: { warn: (message) => warnings.push(message) },
    });

    await expect(client.heartbeat({ agentId: "a1" })).rejects.toThrow(McClientError);
    expect(mutation).toHaveBeenCalledTimes(2);
    for (const message of warnings) {
      expect(message).not.toContain("secret-deploy.convex.cloud");
    }
  });

  it("completeRun defaults unknown tokens and cost to 0 (MC validator requires them)", async () => {
    const mutation = vi.fn().mockResolvedValue({ success: true });
    const client = new McClient(mockTransport({ mutation }));

    await client.completeRun({ runId: "r1", status: "COMPLETED" });
    expect(mutation).toHaveBeenCalledWith("runs:complete", expect.objectContaining({
      runId: "r1",
      status: "COMPLETED",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }));
  });

  it("startRun returns the Mission Control run id", async () => {
    const mutation = vi.fn().mockResolvedValue({ run: { _id: "runs:abc" }, created: true });
    const client = new McClient(mockTransport({ mutation }));

    const runId = await client.startRun({
      agentId: "a1",
      sessionKey: "pi-bridge:run1",
      model: "hermes",
      idempotencyKey: "pib:run:wo1:run1",
    });
    expect(runId).toBe("runs:abc");
    expect(mutation).toHaveBeenCalledWith("runs:start", expect.objectContaining({ model: "hermes" }));
  });

  it("routes queries and mutations to the expected Convex function paths", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const mutation = vi.fn().mockResolvedValue({});
    const client = new McClient(mockTransport({ query, mutation }));

    await client.listClaimable(5);
    expect(query).toHaveBeenCalledWith("workOrdersExecutor:listClaimable", { limit: 5 });

    await client.registerAgent({ name: "pi-supervisor", role: "LEAD", workspacePath: "/tmp/pi" });
    expect(mutation).toHaveBeenCalledWith("agents:register", expect.objectContaining({ role: "LEAD" }));

    await client.recordVerificationEvidence({
      workOrderId: "wo1",
      agentId: "a1",
      criterionId: "c1",
      status: "PASS",
      evidence: "tests green",
      idempotencyKey: "pib:verify:wo1:c1:run1",
    });
    expect(mutation).toHaveBeenCalledWith(
      "workOrdersExecutor:recordVerificationEvidence",
      expect.objectContaining({ criterionId: "c1", status: "PASS" }),
    );

    await client.recordExecutorArtifact({
      workOrderId: "wo1",
      agentId: "a1",
      artifactId: "report.md@abc",
      title: "report.md",
      content: "# report",
      sha256: "deadbeef",
      idempotencyKey: "pib:art:wo1:report.md@abc",
    });
    expect(mutation).toHaveBeenCalledWith(
      "workOrdersExecutor:recordExecutorArtifact",
      expect.objectContaining({ artifactId: "report.md@abc" }),
    );
  });
});
