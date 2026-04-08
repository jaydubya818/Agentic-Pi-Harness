import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDefaultModelClient, isRealProviderConfigured } from "../../src/adapter/defaultClient.js";
import { MockModelClient } from "../../src/adapter/pi-adapter.js";
import { PiAdapterClient } from "../../src/adapter/pi-client.js";

describe("createDefaultModelClient", () => {
  const snap = { ...process.env };
  beforeEach(() => {
    delete process.env.PI_HARNESS_PROVIDER;
    delete process.env.PI_HARNESS_MODEL;
    delete process.env.PI_HARNESS_API_KEY;
  });
  afterEach(() => {
    process.env = { ...snap };
  });

  it("returns MockModelClient when env is not set", () => {
    const c = createDefaultModelClient([
      { type: "message_start", schemaVersion: 1 },
      { type: "message_stop", schemaVersion: 1, stopReason: "end_turn" },
    ]);
    expect(c).toBeInstanceOf(MockModelClient);
    expect(isRealProviderConfigured()).toBe(false);
  });

  it("returns PiAdapterClient when PI_HARNESS_PROVIDER + PI_HARNESS_MODEL are set", () => {
    process.env.PI_HARNESS_PROVIDER = "anthropic";
    process.env.PI_HARNESS_MODEL = "claude-sonnet-4-6";
    const c = createDefaultModelClient([]);
    expect(c).toBeInstanceOf(PiAdapterClient);
    expect(c.name).toBe("pi.dev:anthropic:claude-sonnet-4-6");
    expect(isRealProviderConfigured()).toBe(true);
  });
});
