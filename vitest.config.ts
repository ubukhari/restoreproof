import { defineConfig } from "vitest/config";

/**
 * No `setupFiles`: the monorepo's shared setup loads the repo's `.env.local`, and this package's
 * tests must never see a real database URL. Every test passes the environment it means explicitly.
 * The tests that start throwaway clusters run only with RESTOREPROOF_TEST_PG_BIN set
 * (src/drill.pg.test.ts).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: { TZ: "UTC" },
    testTimeout: 30_000,
  },
});
