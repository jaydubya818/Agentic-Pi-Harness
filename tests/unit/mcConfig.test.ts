import { describe, expect, it } from "vitest";
import { loadMcConfig, McConfigError } from "../../src/mc/config.js";

describe("loadMcConfig", () => {
  it("is disabled by default (empty env → null)", () => {
    expect(loadMcConfig({})).toBeNull();
  });

  it("treats falsy switch values as disabled", () => {
    expect(loadMcConfig({ MC_EXECUTOR_ENABLED: "0" })).toBeNull();
    expect(loadMcConfig({ MC_EXECUTOR_ENABLED: "false" })).toBeNull();
    expect(loadMcConfig({ MC_EXECUTOR_ENABLED: "" })).toBeNull();
  });

  it("requires MC_CONVEX_URL when enabled", () => {
    expect(() => loadMcConfig({ MC_EXECUTOR_ENABLED: "1" })).toThrow(McConfigError);
    expect(() => loadMcConfig({ MC_EXECUTOR_ENABLED: "true", MC_CONVEX_URL: "  " })).toThrow(McConfigError);
  });

  it("applies documented defaults when enabled", () => {
    const config = loadMcConfig({
      MC_EXECUTOR_ENABLED: "true",
      MC_CONVEX_URL: "https://example.convex.cloud",
    });
    expect(config).not.toBeNull();
    expect(config!.convexUrl).toBe("https://example.convex.cloud");
    expect(config!.claimPollEnabled).toBe(false);
    expect(config!.supervisorAgentName).toBe("pi-supervisor");
    expect(config!.workerAgentName).toBe("hermes-executor");
    expect(config!.heartbeatIntervalMs).toBe(30_000);
    expect(config!.claimPollIntervalMs).toBe(15_000);
    expect(config!.sessionLogExcerptMaxBytes).toBe(4096);
  });

  it("honors overrides for every knob", () => {
    const config = loadMcConfig({
      MC_EXECUTOR_ENABLED: "yes",
      MC_CONVEX_URL: "https://example.convex.cloud",
      MC_CLAIM_POLL_ENABLED: "on",
      MC_SUPERVISOR_AGENT_NAME: "custom-supervisor",
      MC_WORKER_AGENT_NAME: "custom-worker",
      MC_HEARTBEAT_INTERVAL_MS: "10000",
      MC_CLAIM_POLL_INTERVAL_MS: "5000",
      MC_SESSION_LOG_EXCERPT_MAX_BYTES: "1024",
    });
    expect(config).not.toBeNull();
    expect(config!.claimPollEnabled).toBe(true);
    expect(config!.supervisorAgentName).toBe("custom-supervisor");
    expect(config!.workerAgentName).toBe("custom-worker");
    expect(config!.heartbeatIntervalMs).toBe(10_000);
    expect(config!.claimPollIntervalMs).toBe(5000);
    expect(config!.sessionLogExcerptMaxBytes).toBe(1024);
  });

  it("rejects non-positive interval overrides", () => {
    expect(() =>
      loadMcConfig({
        MC_EXECUTOR_ENABLED: "1",
        MC_CONVEX_URL: "https://example.convex.cloud",
        MC_HEARTBEAT_INTERVAL_MS: "-5",
      }),
    ).toThrow();
  });
});
