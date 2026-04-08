/**
 * Streaming tool concurrency classification. Mirrors Claude Code's three
 * classes so a sequence of tool_use events can be scheduled correctly:
 *
 *   - readonly   : may run in parallel with any other readonly tool
 *   - serial     : must run one at a time per tool name (same-name queue)
 *   - exclusive  : drains the pipeline; nothing runs before or after until done
 *
 * Classification is declarative. The executor consults the classifier before
 * dispatching each call.
 */

export type ToolClass = "readonly" | "serial" | "exclusive";

export interface ToolManifestEntry {
  name: string;
  class: ToolClass;
}

export class ConcurrencyClassifier {
  private map = new Map<string, ToolClass>();
  constructor(entries: ToolManifestEntry[]) {
    for (const e of entries) this.map.set(e.name, e.class);
  }
  classify(toolName: string): ToolClass {
    return this.map.get(toolName) ?? "serial"; // default to safest non-exclusive
  }
}

export interface PendingCall { id: string; name: string; run: () => Promise<void>; }

/**
 * Schedule a batch of pending calls honoring the concurrency classes.
 * Returns when every call has settled.
 */
export async function schedule(calls: PendingCall[], cc: ConcurrencyClassifier): Promise<void> {
  const serialLocks = new Map<string, Promise<void>>();
  const all: Promise<void>[] = [];
  let pipelineDrain: Promise<void> = Promise.resolve();

  for (const call of calls) {
    const cls = cc.classify(call.name);
    if (cls === "exclusive") {
      const snapshot = all.slice();
      pipelineDrain = pipelineDrain
        .then(() => Promise.allSettled(snapshot))
        .then(() => call.run());
      all.push(pipelineDrain);
      continue;
    }
    if (cls === "serial") {
      const prev = serialLocks.get(call.name) ?? Promise.resolve();
      const next = prev.then(() => call.run());
      serialLocks.set(call.name, next);
      all.push(next);
      continue;
    }
    // readonly
    all.push(pipelineDrain.then(() => call.run()));
  }
  await Promise.allSettled(all);
}
