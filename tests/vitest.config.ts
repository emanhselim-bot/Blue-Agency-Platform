import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    // Global test environment — use jsdom for browser-like env in unit tests
    environment: "node",

    // Load .env.test automatically before every test file
    setupFiles: ["./setup/vitest-setup.ts"],

    // Increase timeout for integration tests (real DB round-trips)
    testTimeout: 15_000,
    hookTimeout: 30_000,

    // Per-directory overrides
    environmentMatchGlobs: [
      ["tests/unit/**", "node"],
      ["tests/integration/**", "node"],
    ],

    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "tests/**",
        "node_modules/**",
        "*.config.*",
      ],
    },

    // Reporters
    reporters: ["verbose"],

    // Retry flaky integration tests once before failing
    retry: 1,
  },

  resolve: {
    alias: {
      "@setup": resolve(__dirname, "setup"),
      "@fixtures": resolve(__dirname, "setup/fixtures"),
    },
  },
});
