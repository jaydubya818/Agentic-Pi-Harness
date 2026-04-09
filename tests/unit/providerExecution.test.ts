import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderExecutionPlan } from "../../src/runtime/providerExecution.js";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { PiAdapterClient } from "../../src/adapter/pi-client.js";

const snapshot = { ...process.env };

describe("provider execution plan", () => {
  beforeEach(() => {
    delete process.env.PI_HARNESS_PROVIDER;
    delete process.env.PI_HARNESS_MODEL;
    delete process.env.PI_HARNESS_API_KEY;
  });

  afterEach(() => {
    process.env = { ...snapshot };
  });

  it("uses deterministic mock fallback when provider env is absent", () => {
    const plan = createProviderExecutionPlan([
      { type: "message_start", schemaVersion: 1 },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ]);

    expect(plan.source).toBe("mock-fallback");
    expect(plan.providerConfigured).toBe(false);
    expect(plan.model).toBeInstanceOf(MockModelClient);
  });

  it("selects the provider-backed client behind the existing seam when env is present", () => {
    process.env.PI_HARNESS_PROVIDER = "anthropic";
    process.env.PI_HARNESS_MODEL = "claude-sonnet-4-6";
    const plan = createProviderExecutionPlan([]);

    expect(plan.source).toBe("provider");
    expect(plan.providerConfigured).toBe(true);
    expect(plan.model).toBeInstanceOf(PiAdapterClient);
    expect(plan.model.name).toBe("pi.dev:anthropic:claude-sonnet-4-6");
  });
});
