import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    globalSetup: ["tests/helpers/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
