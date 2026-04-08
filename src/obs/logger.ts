/**
 * Structured logger surface.
 *
 * Defaults to a zero-dep no-op logger. Call `createPinoLogger()` to get a
 * real pino-backed sink — lazy-imports `pino` so the harness stays dep-
 * free unless you want structured logs.
 *
 * Events are correlated by sessionId, which is the only required field.
 * Levels mirror pino: trace / debug / info / warn / error.
 */

import { PiHarnessError } from "../errors.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Default: drops everything. Zero cost. */
export class NoopLogger implements Logger {
  log(): void {}
  child(): Logger { return this; }
}

/** Writes one JSON object per log call to stdout. Zero-dep alternative to pino. */
export class JsonLogger implements Logger {
  constructor(private bindings: Record<string, unknown> = {}) {}
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    process.stdout.write(
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        event,
        ...this.bindings,
        ...fields,
      }) + "\n",
    );
  }
  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings });
  }
}

/**
 * Lazy pino adapter. Throws E_LOG_UNAVAILABLE if `pino` isn't installed.
 * Pino is faster and has proper log rotation / transport support, so
 * use this in production; JsonLogger is fine for tests and dev.
 */
export async function createPinoLogger(bindings: Record<string, unknown> = {}): Promise<Logger> {
  let pino: any;
  try {
    // @ts-ignore — optional peer dep, not declared in package.json
    pino = (await import("pino")).default;
  } catch (e) {
    throw new PiHarnessError(
      "E_LOG_UNAVAILABLE",
      "createPinoLogger requires pino as a peer dep",
      { cause: String(e) },
    );
  }
  const base = pino(bindings);
  const wrap = (l: any): Logger => ({
    log(level, event, fields = {}) {
      (l[level] as any)({ event, ...fields });
    },
    child(b) { return wrap(l.child(b)); },
  });
  return wrap(base);
}
