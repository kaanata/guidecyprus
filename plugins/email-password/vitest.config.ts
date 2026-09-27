import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // PBKDF2 at 600,000 iterations takes a few hundred ms per hash.
    testTimeout: 30_000,
  },
});
