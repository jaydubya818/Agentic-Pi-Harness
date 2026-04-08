/** Observability-lite: in-memory counters. OTel swap-in is Tier C. */
export class Counters {
  private c = new Map<string, number>();
  inc(key: string, by = 1): void { this.c.set(key, (this.c.get(key) ?? 0) + by); }
  snapshot(): Record<string, number> { return Object.fromEntries(this.c); }
}
