import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/replay/recorder.js";
import { StreamEvent } from "../../src/schemas/index.js";

/**
 * Hash-chain micro-benchmark.
 *
 * ADR 0002 budgets the prevHash/recordHash computation at p99 ≤ 2ms per
 * record on dev laptops. This test fails the build if a regression pushes
 * us above that.
 *
 * The bench is tiny (N=2000) to keep CI fast; the 2ms threshold is
 * generous enough that CI noise shouldn't flap it.
 */
describe("hash-chain bench", () => {
  it("p99 per-record latency stays under 2ms", async () => {
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
    console.log(`hashChain bench: N=${N} p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
    expect(p99).toBeLessThan(2.0);
  }, 30_000);
});
