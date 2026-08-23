/**
 * Observability surface for the loop.
 *
 * v0.1.0 shipped an in-memory-only `Counters`. v0.2.0 promotes this to an
 * interface so OTel (or Prometheus, or anything) can plug in without
 * forcing a runtime dep. The default export remains in-memory — no one
 * who doesn't want OTel has to pay for it.
 */

import { compareCodeUnits } from "../schemas/canonical.js";

export interface CountersSink {
  inc(key: string, by?: number): void;
  /**
   * Keys must come back in a total, build-independent order. `run.ts` writes
   * this straight to `sessions/<id>/metrics.json` via `safeWriteJson`, which
   * is `JSON.stringify` -- it preserves whatever order the object carries. A
   * `Map` in first-increment order is *not* deterministic: `tool.error` and
   * `sanitize.*` are incremented from inside `executeApprovedTool`, which runs
   * concurrently under `runWithFanoutLimit` for a readonly group, so which key
   * is touched first is decided by I/O completion. Two runs with identical
   * counter values then produce byte-different artifacts.
   */
  snapshot(): Record<string, number>;
}

/** Default in-memory implementation. Zero deps. */
export class Counters implements CountersSink {
  private c = new Map<string, number>();
  inc(key: string, by = 1): void { this.c.set(key, (this.c.get(key) ?? 0) + by); }
  snapshot(): Record<string, number> { return sortedSnapshot(this.c); }
}

/**
 * `compareCodeUnits` rather than `localeCompare`, for the reasons spelled out
 * at its definition in `src/schemas/canonical.ts`: ICU collation is neither
 * antisymmetric over distinct strings nor stable across Node builds.
 */
function sortedSnapshot(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => compareCodeUnits(a[0], b[0])));
}

/**
 * Fan-out sink: delegates to N underlying sinks. Useful for running
 * in-memory + OTel at the same time — you still get `counters.snapshot()`
 * in `LoopResult` for tests, and OTel sees every increment in real time.
 */
export class FanOutCounters implements CountersSink {
  constructor(private sinks: CountersSink[]) {}
  inc(key: string, by = 1): void { for (const s of this.sinks) s.inc(key, by); }
  snapshot(): Record<string, number> {
    // Snapshot from the first in-memory sink if available, else empty.
    for (const s of this.sinks) {
      const snap = s.snapshot();
      if (Object.keys(snap).length > 0) return snap;
    }
    return this.sinks[0]?.snapshot() ?? {};
  }
}
