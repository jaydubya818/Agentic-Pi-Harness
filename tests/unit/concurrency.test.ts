import { describe, it, expect } from "vitest";
import { ConcurrencyClassifier, schedule, PendingCall } from "../../src/tools/concurrency.js";

describe("concurrency schedule", () => {
  it("runs readonly in parallel, serial same-name one-at-a-time, exclusive drains", async () => {
    const cc = new ConcurrencyClassifier([
      { name: "read_file", class: "readonly" },
      { name: "write_file", class: "serial" },
      { name: "bash", class: "exclusive" },
    ]);

    const log: string[] = [];
    const active: Record<string, number> = { read_file: 0, write_file: 0, bash: 0 };
    let maxReadParallel = 0;
    let maxWriteParallel = 0;
    let bashSawOtherActive = false;

    const mk = (name: string, id: string): PendingCall => ({
      id, name,
      run: async () => {
        active[name]++;
        maxReadParallel = Math.max(maxReadParallel, active.read_file);
        maxWriteParallel = Math.max(maxWriteParallel, active.write_file);
        if (name === "bash" && (active.read_file > 0 || active.write_file > 0)) bashSawOtherActive = true;
        await new Promise((r) => setTimeout(r, 10));
        log.push(id);
        active[name]--;
      },
    });

    const calls: PendingCall[] = [
      mk("read_file", "r1"), mk("read_file", "r2"),
      mk("write_file", "w1"), mk("write_file", "w2"),
      mk("bash", "b1"),
      mk("read_file", "r3"),
    ];
    await schedule(calls, cc);

    expect(log).toContain("b1");
    expect(maxReadParallel).toBeGreaterThanOrEqual(2);
    expect(maxWriteParallel).toBeLessThanOrEqual(1);
    expect(bashSawOtherActive).toBe(false);
  });
});
