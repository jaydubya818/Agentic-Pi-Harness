import { join } from "node:path";
import { safeWriteJson } from "../session/provenance.js";
import type { McClient, McHeartbeatResult } from "./client.js";
import type { McConfig } from "./config.js";
import { defaultMcStateDir, type McIdentity } from "./identity.js";

/** Local degradation threshold: 2 minutes without a successful heartbeat. */
export const HEARTBEAT_DEGRADED_AFTER_MS = 2 * 60_000;

export interface HeartbeatHandle {
  stop(): void;
  /** True after >= 2 minutes without a successful heartbeat pair. */
  isDegraded(): boolean;
  /** True while the backend reports budgetExceeded for either identity. */
  isClaimingPaused(): boolean;
}

export interface StartHeartbeatsOptions {
  client: Pick<McClient, "heartbeat">;
  config: McConfig;
  identity: McIdentity;
  stateDir?: string;
  warn?: (message: string) => void;
  now?: () => number;
}

interface McHealthState {
  degraded: boolean;
  budgetExceeded: boolean;
  lastSuccessAt: string | null;
  updatedAt: string;
}

/**
 * Heartbeat BOTH identities on an interval. Local failure tracking only emits
 * a DEGRADED warning (console + state-file flag) — the adapter never
 * self-quarantines and never hard-codes the backend's stale threshold; it
 * consumes the backend's own heartbeat response instead. budgetExceeded from
 * the backend pauses claiming until a heartbeat clears it.
 */
export function startHeartbeats(options: StartHeartbeatsOptions): HeartbeatHandle {
  const stateDir = options.stateDir ?? defaultMcStateDir();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const now = options.now ?? Date.now;

  let lastSuccessAt = now();
  let degraded = false;
  let budgetExceeded = false;
  let stopped = false;

  const persistHealth = async (): Promise<void> => {
    const state: McHealthState = {
      degraded,
      budgetExceeded,
      lastSuccessAt: new Date(lastSuccessAt).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    try {
      await safeWriteJson(join(stateDir, "mc-health.json"), state);
    } catch {
      // health flag persistence is best-effort
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const results = await Promise.allSettled([
      options.client.heartbeat({ agentId: options.identity.supervisorId }),
      options.client.heartbeat({ agentId: options.identity.workerId }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<McHeartbeatResult> => result.status === "fulfilled",
    );
    const allOk = fulfilled.length === results.length && fulfilled.every((result) => result.value.success !== false);

    if (allOk) {
      lastSuccessAt = now();
      const anyBudgetExceeded = fulfilled.some((result) => result.value.budgetExceeded === true);
      if (anyBudgetExceeded && !budgetExceeded) {
        budgetExceeded = true;
        warn("[mc-adapter] backend reports budgetExceeded — pausing work-order claiming");
        await persistHealth();
      } else if (!anyBudgetExceeded && budgetExceeded) {
        budgetExceeded = false;
        warn("[mc-adapter] budget restored — resuming work-order claiming");
        await persistHealth();
      }
      if (degraded) {
        degraded = false;
        warn("[mc-adapter] heartbeat recovered — clearing DEGRADED flag");
        await persistHealth();
      }
      return;
    }

    if (!degraded && now() - lastSuccessAt >= HEARTBEAT_DEGRADED_AFTER_MS) {
      degraded = true;
      warn(
        `[mc-adapter] DEGRADED: no successful Mission Control heartbeat for ${Math.round((now() - lastSuccessAt) / 1000)}s (continuing; not self-quarantining)`,
      );
      await persistHealth();
    }
  };

  const interval = setInterval(() => {
    void tick().catch(() => {
      // tick never throws in practice; guard to keep the interval alive
    });
  }, options.config.heartbeatIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    isDegraded: () => degraded,
    isClaimingPaused: () => budgetExceeded,
  };
}
