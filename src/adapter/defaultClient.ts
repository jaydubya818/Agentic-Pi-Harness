import { ModelClient, MockModelClient } from "./pi-adapter.js";
import { PiAdapterClient } from "./pi-client.js";
import { PiDevProvider } from "./piDevProvider.js";
import { StreamEvent } from "../schemas/index.js";

/**
 * Choose a model client based on environment. If PI_HARNESS_PROVIDER +
 * PI_HARNESS_MODEL are set, return a real PiDevProvider-backed client.
 * Otherwise fall back to the given MockModelClient (or a scripted fake).
 *
 * This is the single place in the harness that decides mock-vs-real. Callers
 * (CLI, tests, embedders) never import pi.dev directly.
 */
export function createDefaultModelClient(fallbackScript: StreamEvent[]): ModelClient {
  const provider = process.env.PI_HARNESS_PROVIDER;
  const model = process.env.PI_HARNESS_MODEL;
  const apiKey = process.env.PI_HARNESS_API_KEY;
  if (provider && model) {
    return new PiAdapterClient(new PiDevProvider({ provider, model, apiKey }));
  }
  return new MockModelClient(fallbackScript);
}

export function isRealProviderConfigured(): boolean {
  return !!(process.env.PI_HARNESS_PROVIDER && process.env.PI_HARNESS_MODEL);
}
