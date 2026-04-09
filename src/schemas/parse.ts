import { z } from "zod";

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, ctx = "parse"): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${ctx}: ${result.error.message}`);
  }
  return result.data;
}
