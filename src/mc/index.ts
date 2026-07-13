import { createConvexTransport, McClient } from "./client.js";
import { loadMcConfig, McConfigError } from "./config.js";
import { startDispatchLoop, type DispatchLoopHandle, type McBridgeLike } from "./dispatchLoop.js";
import { startHeartbeats, type HeartbeatHandle } from "./heartbeat.js";
import { ensureIdentities } from "./identity.js";

export * from "./client.js";
export * from "./config.js";
export * from "./dispatchLoop.js";
export * from "./heartbeat.js";
export * from "./identity.js";
export * from "./sessionLogs.js";
export * from "./stateMap.js";

export interface McAdapterHandle {
  stop(): void;
}

/**
 * Start the Mission Control executor adapter if MC_EXECUTOR_ENABLED is set.
 * No-op (returns null) when disabled — the default. Wires config → client →
 * identities → heartbeats → optional claim/dispatch loop. Never logs the
 * Convex URL or tokens. Adapter startup failures are contained: the bridge
 * keeps running without MC integration.
 */
export async function maybeStartMcAdapter(
  bridge: McBridgeLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McAdapterHandle | null> {
  let heartbeats: HeartbeatHandle | null = null;
  let dispatch: DispatchLoopHandle | null = null;

  try {
    const config = loadMcConfig(env);
    if (!config) return null;

    const client = new McClient(createConvexTransport(config.convexUrl));
    const identity = await ensureIdentities(client, config);
    heartbeats = startHeartbeats({ client, config, identity });
    if (config.claimPollEnabled) {
      const heartbeatHandle = heartbeats;
      dispatch = startDispatchLoop({
        client,
        config,
        bridge,
        identity,
        isClaimingPaused: () => heartbeatHandle.isClaimingPaused(),
      });
    }

    console.log(
      `[mc-adapter] started (supervisor=${identity.supervisorName}, worker=${identity.workerName}, claimPoll=${config.claimPollEnabled ? "on" : "off"})`,
    );

    return {
      stop: () => {
        dispatch?.stop();
        heartbeats?.stop();
      },
    };
  } catch (error) {
    heartbeats?.stop();
    dispatch?.stop();
    const label = error instanceof McConfigError ? "configuration error" : "startup failed";
    console.error(
      `[mc-adapter] ${label}; continuing without Mission Control integration: ${error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]") : String(error)}`,
    );
    return null;
  }
}
