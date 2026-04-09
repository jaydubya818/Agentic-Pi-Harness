import { createDefaultModelClient, isRealProviderConfigured } from "../adapter/defaultClient.js";
import { ModelClient } from "../adapter/pi-adapter.js";
import { StreamEvent } from "../schemas/index.js";

export interface ProviderExecutionPlan {
  model: ModelClient;
  source: "mock-fallback" | "provider";
  providerConfigured: boolean;
}

export function createProviderExecutionPlan(fallbackScript: StreamEvent[]): ProviderExecutionPlan {
  const providerConfigured = isRealProviderConfigured();
  return {
    model: createDefaultModelClient(fallbackScript),
    source: providerConfigured ? "provider" : "mock-fallback",
    providerConfigured,
  };
}
