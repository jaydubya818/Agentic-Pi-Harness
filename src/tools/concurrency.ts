export type ToolClass = "readonly" | "serial" | "exclusive";

export interface ToolManifestEntry {
  name: string;
  class: ToolClass;
}

export class ConcurrencyClassifier {
  private map = new Map<string, ToolClass>();

  constructor(entries: ToolManifestEntry[]) {
    for (const entry of entries) this.map.set(entry.name, entry.class);
  }

  classify(toolName: string): ToolClass {
    return this.map.get(toolName) ?? "serial";
  }
}

export interface PendingCall {
  id: string;
  name: string;
  run: () => Promise<void>;
}

export interface ScheduledCall<T> {
  id: string;
  name: string;
  order: number;
  run: () => Promise<T>;
}

export interface ClassifiedCall<T> extends ScheduledCall<T> {
  class: ToolClass;
}

export interface ExecutionGroup<T> {
  class: ToolClass;
  calls: ClassifiedCall<T>[];
}

export interface ScheduledResult<T> {
  call: ClassifiedCall<T>;
  result: PromiseSettledResult<T>;
}

export function classifyToolCall<T>(call: ScheduledCall<T>, classifier: ConcurrencyClassifier): ClassifiedCall<T> {
  return {
    ...call,
    class: classifier.classify(call.name),
  };
}

export function classifyToolCalls<T>(calls: ScheduledCall<T>[], classifier: ConcurrencyClassifier): ClassifiedCall<T>[] {
  return calls.map((call) => classifyToolCall(call, classifier));
}

export function buildExecutionPlan<T>(calls: ClassifiedCall<T>[]): ExecutionGroup<T>[] {
  const ordered = [...calls].sort((a, b) => a.order - b.order);
  const groups: ExecutionGroup<T>[] = [];
  let readonlyGroup: ClassifiedCall<T>[] = [];

  const flushReadonly = () => {
    if (readonlyGroup.length === 0) return;
    groups.push({ class: "readonly", calls: readonlyGroup });
    readonlyGroup = [];
  };

  for (const call of ordered) {
    if (call.class === "readonly") {
      readonlyGroup.push(call);
      continue;
    }

    flushReadonly();
    groups.push({ class: call.class, calls: [call] });
  }

  flushReadonly();
  return groups;
}

export async function scheduleCalls<T>(calls: ScheduledCall<T>[], classifier: ConcurrencyClassifier): Promise<ScheduledResult<T>[]> {
  const results: ScheduledResult<T>[] = [];
  const plan = buildExecutionPlan(classifyToolCalls(calls, classifier));

  for (const group of plan) {
    if (group.class === "readonly") {
      const settled = await Promise.allSettled(group.calls.map((call) => call.run()));
      for (let index = 0; index < group.calls.length; index++) {
        results.push({ call: group.calls[index], result: settled[index] });
      }
      continue;
    }

    const call = group.calls[0];
    const [settled] = await Promise.allSettled([call.run()]);
    results.push({ call, result: settled });
  }

  return results.sort((a, b) => a.call.order - b.call.order);
}

export async function schedule(calls: PendingCall[], classifier: ConcurrencyClassifier): Promise<void> {
  const scheduledCalls: ScheduledCall<void>[] = calls.map((call, index) => ({
    id: call.id,
    name: call.name,
    order: index,
    run: call.run,
  }));

  await scheduleCalls(scheduledCalls, classifier);
}
