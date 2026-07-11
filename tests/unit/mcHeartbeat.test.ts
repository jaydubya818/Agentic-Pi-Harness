import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McHeartbeatResult } from "../../src/mc/client.js";
import type { McConfig } from "../../src/mc/config.js";
import { HEARTBEAT_DEGRADED_AFTER_MS, startHeartbeats } from "../../src/mc/heartbeat.js";
import type { McIdentity } from "../../src/mc/identity.js";

const createdPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdPaths.push(dir);
  return dir;
}

const identity: McIdentity = {
  supervisorId: "agents:sup",
  workerId: "agents:worker",
  supervisorName: "pi-supervisor",
  workerName: "hermes-executor",
};

const config: McConfig = {
  convexUrl: "https://example.convex.cloud",
  claimPollEnabled: false,
  supervisorAgentName: "pi-supervisor",
  workerAgentName: "hermes-executor",
  heartbeatIntervalMs: 30_000,
  claimPollIntervalMs: 15_000,
  sessionLogExcerptMaxBytes: 4096,
};

function okHeartbeat(overrides: Partial<McHeartbeatResult> = {}): McHeartbeatResult {
  return { success: true, budgetExceeded: false, budgetRemaining: 5, ...overrides };
}

// Captured before fake timers are installed so I/O waits use wall-clock time
// (fsync needs real event-loop poll time; spinning immediates starves it).
const realSetTimeout = setTimeout;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

async function waitForHealth(
  stateDir: string,
  predicate: (health: { degraded: boolean }) => boolean,
): Promise<{ degraded: boolean }> {
  for (let i = 0; i < 400; i++) {
    try {
      const health = JSON.parse(await readFile(join(stateDir, "mc-health.json"), "utf8")) as { degraded: boolean };
      if (predicate(health)) return health;
    } catch {
      // not written yet
    }
    await new Promise<void>((resolvePromise) => realSetTimeout(resolvePromise, 5));
  }
  throw new Error("timed out waiting for mc-health.json");
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("startHeartbeats DEGRADED logic", () => {
  it("flags DEGRADED after 2 minutes without a successful heartbeat and persists the flag", async () => {
    const stateDir = await makeTempDir("mc-hb-");
    const warnings: string[] = [];
    const client = { heartbeat: vi.fn().mockRejectedValue(new Error("fetch failed")) };

    const handle = startHeartbeats({ client, config, identity, stateDir, warn: (m) => warnings.push(m) });
    expect(handle.isDegraded()).toBe(false);

    // 3 ticks = 90s: still under the 2-minute threshold.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(handle.isDegraded()).toBe(false);

    // 4th tick at 120s crosses the threshold.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.isDegraded()).toBe(true);
    expect(warnings.some((message) => message.includes("DEGRADED"))).toBe(true);

    const health = await waitForHealth(stateDir, (state) => state.degraded === true);
    expect(health.degraded).toBe(true);

    handle.stop();
  });

  it("clears the DEGRADED flag on recovery", async () => {
    const stateDir = await makeTempDir("mc-hb-");
    const warnings: string[] = [];
    let failing = true;
    const client = {
      heartbeat: vi.fn().mockImplementation(() =>
        failing ? Promise.reject(new Error("fetch failed")) : Promise.resolve(okHeartbeat()),
      ),
    };

    const handle = startHeartbeats({ client, config, identity, stateDir, warn: (m) => warnings.push(m) });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEGRADED_AFTER_MS);
    expect(handle.isDegraded()).toBe(true);

    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.isDegraded()).toBe(false);
    expect(warnings.some((message) => message.includes("recovered"))).toBe(true);

    const health = await waitForHealth(stateDir, (state) => state.degraded === false);
    expect(health.degraded).toBe(false);

    handle.stop();
  });

  it("heartbeats BOTH identities every interval", async () => {
    const stateDir = await makeTempDir("mc-hb-");
    const heartbeat = vi.fn().mockResolvedValue(okHeartbeat());
    const handle = startHeartbeats({ client: { heartbeat }, config, identity, stateDir, warn: () => undefined });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);
    const agentIds = heartbeat.mock.calls.map((call) => (call[0] as { agentId: string }).agentId);
    expect(agentIds).toContain("agents:sup");
    expect(agentIds).toContain("agents:worker");

    handle.stop();
  });

  it("pauses claiming when the backend reports budgetExceeded and resumes when it clears", async () => {
    const stateDir = await makeTempDir("mc-hb-");
    let exceeded = true;
    const client = {
      heartbeat: vi.fn().mockImplementation(() => Promise.resolve(okHeartbeat({ budgetExceeded: exceeded }))),
    };
    const handle = startHeartbeats({ client, config, identity, stateDir, warn: () => undefined });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.isClaimingPaused()).toBe(true);
    // Backend budget response is consumed — no local DEGRADED self-quarantine.
    expect(handle.isDegraded()).toBe(false);

    exceeded = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.isClaimingPaused()).toBe(false);

    handle.stop();
  });

  it("stop() halts further heartbeats", async () => {
    const stateDir = await makeTempDir("mc-hb-");
    const heartbeat = vi.fn().mockResolvedValue(okHeartbeat());
    const handle = startHeartbeats({ client: { heartbeat }, config, identity, stateDir, warn: () => undefined });

    await vi.advanceTimersByTimeAsync(30_000);
    const callsAfterOneTick = heartbeat.mock.calls.length;
    handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeat.mock.calls.length).toBe(callsAfterOneTick);
  });
});
