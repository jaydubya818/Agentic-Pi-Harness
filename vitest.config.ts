import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.fuzz.test.ts"],
    root: __dirname,
    dir: __dirname,
  },
});
