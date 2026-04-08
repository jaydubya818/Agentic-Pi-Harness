/**
 * Optional OpenTelemetry counter sink.
 *
 * Lazy-imports `@opentelemetry/api` so this file is safe to ship even if
 * the host project hasn't installed OTel. Call `createOtelCounters()`
 * only from code paths where you know OTel is available; it will throw
 * E_OTEL_UNAVAILABLE if the package isn't resolvable.
 *
 * Usage:
 *   import { FanOutCounters, Counters } from "./counter.js";
 *   import { createOtelCounters } from "./otel.js";
 *   const sink = new FanOutCounters([new Counters(), await createOtelCounters("pi-harness")]);
 *   const result = await runQueryLoop({ ..., counters: sink });
 */

import type { CountersSink } from "./counter.js";
import { PiHarnessError } from "../errors.js";

export async function createOtelCounters(meterName = "agentic-pi-harness"): Promise<CountersSink> {
  let api: any;
  try {
    // Node resolves this only if the host project has @opentelemetry/api installed.
    // @ts-ignore — optional peer dep, not declared in package.json
    api = await import("@opentelemetry/api");
  } catch (e) {
    throw new PiHarnessError(
      "E_OTEL_UNAVAILABLE",
      "createOtelCounters requires @opentelemetry/api as a peer dep",
      { cause: String(e) },
    );
  }

  const meter = api.metrics.getMeter(meterName);
  // One Counter instrument per key, lazily created. OTel Counters are
  // monotonic, which matches the Counters.inc contract.
  const instruments = new Map<string, any>();
  const local = new Map<string, number>();

  return {
    inc(key: string, by = 1): void {
      let inst = instruments.get(key);
      if (!inst) {
        inst = meter.createCounter(key, { description: `pi-harness ${key}` });
        instruments.set(key, inst);
      }
      inst.add(by);
      local.set(key, (local.get(key) ?? 0) + by);
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries(local);
    },
  };
}
