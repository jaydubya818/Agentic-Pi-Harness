/**
 * Observability surface for the loop.
 *
 * v0.1.0 shipped an in-memory-only `Counters`. v0.2.0 promotes this to an
 * interface so OTel (or Prometheus, or anything) can plug in without
 * forcing a runtime dep. The default export remains in-memory — no one
 * who doesn't want OTel has to pay for it.
 */

export interface CountersSink {
  inc(key: string, by?: number): void;
  snapshot(): Record<string, number>;
}

/** Default in-memory implementation. Zero deps. */
export class Counters implements CountersSink {
  private c = new Map<string, number>();
  inc(key: string, by = 1): void { this.c.set(key, (this.c.get(key) ?? 0) + by); }
  snapshot(): Record<string, number> { return Object.fromEntries(this.c); }
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
