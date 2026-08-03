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
