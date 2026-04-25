import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/fuzz/**/*.test.ts",
      "tests/chaos/**/*.test.ts",
    ],
    root: __dirname,
    dir: __dirname,
  },
});
