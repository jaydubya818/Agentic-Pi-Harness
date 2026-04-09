import { describe, expect, it } from "vitest";
import {
  buildExecutionPlan,
  classifyToolCall,
  ConcurrencyClassifier,
  scheduleCalls,
  ScheduledCall,
} from "../../src/tools/concurrency.js";

describe("tool scheduling helpers", () => {
  it("classifies tools deterministically", () => {
    const classifier = new ConcurrencyClassifier([
      { name: "read_file", class: "readonly" },
      { name: "write_file", class: "serial" },
      { name: "bash", class: "exclusive" },
    ]);

    expect(classifyToolCall({ id: "r1", name: "read_file", order: 0, run: async () => undefined }, classifier).class).toBe("readonly");
    expect(classifyToolCall({ id: "w1", name: "write_file", order: 1, run: async () => undefined }, classifier).class).toBe("serial");
    expect(classifyToolCall({ id: "x1", name: "bash", order: 2, run: async () => undefined }, classifier).class).toBe("exclusive");
    expect(classifyToolCall({ id: "u1", name: "unknown_tool", order: 3, run: async () => undefined }, classifier).class).toBe("serial");
  });

  it("builds a deterministic execution plan with readonly groups and serial/exclusive barriers", () => {
    const classifier = new ConcurrencyClassifier([
      { name: "read_file", class: "readonly" },
      { name: "write_file", class: "serial" },
      { name: "bash", class: "exclusive" },
    ]);
    const calls = [
      classifyToolCall({ id: "r1", name: "read_file", order: 0, run: async () => "r1" }, classifier),
      classifyToolCall({ id: "r2", name: "read_file", order: 1, run: async () => "r2" }, classifier),
      classifyToolCall({ id: "w1", name: "write_file", order: 2, run: async () => "w1" }, classifier),
      classifyToolCall({ id: "b1", name: "bash", order: 3, run: async () => "b1" }, classifier),
      classifyToolCall({ id: "r3", name: "read_file", order: 4, run: async () => "r3" }, classifier),
    ];

    expect(buildExecutionPlan(calls).map((group) => ({
      class: group.class,
      ids: group.calls.map((call) => call.id),
    }))).toEqual([
      { class: "readonly", ids: ["r1", "r2"] },
      { class: "serial", ids: ["w1"] },
      { class: "exclusive", ids: ["b1"] },
      { class: "readonly", ids: ["r3"] },
    ]);
  });

  it("runs readonly calls in parallel while preserving deterministic result collation order", async () => {
    const classifier = new ConcurrencyClassifier([
      { name: "read_file", class: "readonly" },
      { name: "write_file", class: "serial" },
      { name: "bash", class: "exclusive" },
    ]);

    const starts: string[] = [];
    const finishes: string[] = [];
    let activeReadonly = 0;
    let maxReadonly = 0;

    const call = (id: string, delayMs: number): ScheduledCall<string> => ({
      id,
      name: "read_file",
      order: Number(id.slice(1)) - 1,
      run: async () => {
        starts.push(id);
        activeReadonly += 1;
        maxReadonly = Math.max(maxReadonly, activeReadonly);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        activeReadonly -= 1;
        finishes.push(id);
        return id;
      },
    });

    const results = await scheduleCalls([
      call("r1", 20),
      call("r2", 1),
      call("r3", 10),
    ], classifier);

    expect(maxReadonly).toBeGreaterThanOrEqual(2);
    expect(starts).toEqual(["r1", "r2", "r3"]);
    expect(finishes).not.toEqual(["r1", "r2", "r3"]);
    expect(results.map((result) => result.call.id)).toEqual(["r1", "r2", "r3"]);
    expect(results.every((result) => result.result.status === "fulfilled")).toBe(true);
  });

  it("serializes mutating calls and makes exclusive calls block surrounding work", async () => {
    const classifier = new ConcurrencyClassifier([
      { name: "read_file", class: "readonly" },
      { name: "write_file", class: "serial" },
      { name: "bash", class: "exclusive" },
    ]);

    const active = { readonly: 0, serial: 0, exclusive: 0 };
    let maxSerial = 0;
    let exclusiveSawOther = false;
    const log: string[] = [];

    const calls: ScheduledCall<string>[] = [
      {
        id: "r1",
        name: "read_file",
        order: 0,
        run: async () => {
          active.readonly += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.readonly -= 1;
          log.push("r1");
          return "r1";
        },
      },
      {
        id: "w1",
        name: "write_file",
        order: 1,
        run: async () => {
          active.serial += 1;
          maxSerial = Math.max(maxSerial, active.serial);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.serial -= 1;
          log.push("w1");
          return "w1";
        },
      },
      {
        id: "w2",
        name: "write_file",
        order: 2,
        run: async () => {
          active.serial += 1;
          maxSerial = Math.max(maxSerial, active.serial);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.serial -= 1;
          log.push("w2");
          return "w2";
        },
      },
      {
        id: "b1",
        name: "bash",
        order: 3,
        run: async () => {
          active.exclusive += 1;
          if (active.readonly > 0 || active.serial > 0) exclusiveSawOther = true;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.exclusive -= 1;
          log.push("b1");
          return "b1";
        },
      },
      {
        id: "r2",
        name: "read_file",
        order: 4,
        run: async () => {
          active.readonly += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.readonly -= 1;
          log.push("r2");
          return "r2";
        },
      },
    ];

    const results = await scheduleCalls(calls, classifier);

    expect(maxSerial).toBe(1);
    expect(exclusiveSawOther).toBe(false);
    expect(log).toEqual(["r1", "w1", "w2", "b1", "r2"]);
    expect(results.map((result) => result.call.id)).toEqual(["r1", "w1", "w2", "b1", "r2"]);
  });
});
