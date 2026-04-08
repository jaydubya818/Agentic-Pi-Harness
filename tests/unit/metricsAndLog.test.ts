import { describe, it, expect } from "vitest";
import { Counters, FanOutCounters } from "../../src/metrics/counter.js";
import { NoopLogger, JsonLogger } from "../../src/obs/logger.js";
import { createOtelCounters } from "../../src/metrics/otel.js";
import { createPinoLogger } from "../../src/obs/logger.js";

describe("Counters + FanOut", () => {
  it("in-memory counters accumulate and snapshot", () => {
    const c = new Counters();
    c.inc("a");
    c.inc("a", 4);
    c.inc("b");
    expect(c.snapshot()).toEqual({ a: 5, b: 1 });
  });

  it("FanOut delegates to every sink", () => {
    const a = new Counters();
    const b = new Counters();
    const fan = new FanOutCounters([a, b]);
    fan.inc("x", 3);
    expect(a.snapshot()).toEqual({ x: 3 });
    expect(b.snapshot()).toEqual({ x: 3 });
  });
});

describe("Logger", () => {
  it("NoopLogger is a no-op and chainable", () => {
    const l = new NoopLogger();
    l.log("info", "e", { k: 1 });
    expect(l.child({ s: "x" })).toBeInstanceOf(NoopLogger);
  });

  it("JsonLogger child merges bindings", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { lines.push(s); return true; };
    try {
      const l = new JsonLogger({ sessionId: "s1" }).child({ turn: 0 });
      l.log("info", "hello", { x: 42 });
    } finally {
      (process.stdout as any).write = orig;
    }
    const rec = JSON.parse(lines[0]);
    expect(rec.event).toBe("hello");
    expect(rec.sessionId).toBe("s1");
    expect(rec.turn).toBe(0);
    expect(rec.x).toBe(42);
    expect(rec.level).toBe("info");
  });
});

describe("optional peer deps", () => {
  it("createOtelCounters throws E_OTEL_UNAVAILABLE when package missing", async () => {
    await expect(createOtelCounters()).rejects.toMatchObject({ code: "E_OTEL_UNAVAILABLE" });
  });

  it("createPinoLogger throws E_LOG_UNAVAILABLE when package missing", async () => {
    await expect(createPinoLogger()).rejects.toMatchObject({ code: "E_LOG_UNAVAILABLE" });
  });
});
