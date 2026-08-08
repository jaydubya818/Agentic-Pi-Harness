import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Shared numeric flag validation for the thin CLI shells. `Number("abc")` is
 * NaN and `Number("8.5")` parses, so an unchecked flag value flows into a
 * schema-validated request and fails deep inside a run with an opaque zod
 * error (or, worse, a NaN deadline) instead of failing at the command line.
 */
export function parseIntFlag(flag: string, raw: string, range: { min: number; max: number }): number {
  // Number() also accepts hex ("0x10"), exponent ("1e3"), and float ("5.0")
  // spellings; every error message here promises "an integer", so only the
  // plain decimal spelling counts.
  const value = /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
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

/**
 * Main-module guard for the CLI entrypoints. The historical spelling
 * `import.meta.url === \`file://${process.argv[1]}\`` fails in two common
 * setups and made the CLI exit 0 having silently done nothing:
 *
 *   - a clone path containing any URL-escaped character (a space yields
 *     `file://...%20...` in import.meta.url vs a literal space in argv[1]);
 *   - a symlinked entrypoint such as an npm `.bin` stub (Node resolves
 *     import.meta.url through the symlink, argv[1] keeps the stub path),
 *     which broke the packaged `kb` binary.
 */
export function isCliEntrypoint(importMetaUrl: string, argvPath: string | undefined = process.argv[1]): boolean {
  if (!argvPath) return false;
  if (importMetaUrl === `file://${argvPath}`) return true;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}
