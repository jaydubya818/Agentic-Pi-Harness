import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { StreamEvent } from "../../src/schemas/index.js";

/**
 * Hash-chain micro-benchmark.
 *
 * This benchmark exercises the full append+fsync path, so the ceiling must
 * track storage and VM variance rather than an idealized in-memory budget.
 * Keep it opt-in and use conservative defaults that still catch real
 * regressions on slower laptops and CI runners.
 */
function resolveBenchCeiling(): number {
  const override = process.env.PI_HASHCHAIN_BENCH_CEILING_MS;
  if (override) return Number(override);
  return process.env.CI ? 16.0 : 12.0;
}

describe("hash-chain bench", () => {
  it("p99 per-record latency stays under the env-aware ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bench-"));
    const tape = new ReplayRecorder(join(dir, "t.jsonl"));
    await tape.writeHeader({
      sessionId: "b", loopGitSha: "dev", policyDigest: "sha256:" + "0".repeat(64),
      costTableVersion: "2026-04-01",
    });

    const N = 2000;
    const samples: number[] = new Array(N);
    const ev: StreamEvent = {
      type: "text_delta", schemaVersion: 1,
      text: "benchmark chunk — moderately sized to mirror real output",
    };

    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await tape.writeEvent(ev);
      const t1 = process.hrtime.bigint();
      samples[i] = Number(t1 - t0) / 1e6; // ms
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(N * 0.5)];
    const p99 = samples[Math.floor(N * 0.99)];
    // eslint-disable-next-line no-console
    const ceiling = resolveBenchCeiling();
    console.log(`hashChain bench: N=${N} p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms ceiling=${ceiling}ms`);
    expect(p99).toBeLessThan(ceiling);
  }, 30_000);
});
