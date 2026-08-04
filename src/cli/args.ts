/**
 * Shared numeric flag validation for the thin CLI shells. `Number("abc")` is
 * NaN and `Number("8.5")` parses, so an unchecked flag value flows into a
 * schema-validated request and fails deep inside a run with an opaque zod
 * error (or, worse, a NaN deadline) instead of failing at the command line.
 */
export function parseIntFlag(flag: string, raw: string, range: { min: number; max: number }): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`invalid ${flag} value: ${JSON.stringify(raw)} (expected an integer ${range.min}-${range.max})`);
  }
  return value;
}

/**
 * Terminal guard for the hermes CLI flag loops. Anything that reaches the
 * end of an else-if chain and still looks like a flag is either a typo
 * (`--objectve`) or a known flag whose trailing value is missing. Both
 * silently fell through before, so a mistyped invocation started a long
 * governed run with default settings instead of failing at the command line.
 */
export function assertKnownFlag(arg: string, knownFlags: string[]): void {
  if (!arg.startsWith("--")) return;
  if (knownFlags.includes(arg)) {
    throw new Error(`flag ${arg} requires a value`);
  }
  throw new Error(`unknown flag: ${arg} (known flags: ${knownFlags.join(", ")})`);
}
