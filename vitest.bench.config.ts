import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/bench/**/*.test.ts"],
    root: __dirname,
    dir: __dirname,
  },
});
