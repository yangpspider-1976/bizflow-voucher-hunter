import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./tests/setup.ts"],
    // Postgres is a network hop, not a local file: resetDb() alone is dozens of
    // statements and the seed is hundreds, so the old 5s defaults expire during
    // setup rather than during anything being tested.
    testTimeout: 60000,
    hookTimeout: 120000,
    // Every file shares one database and resetDb() empties it, so the suite
    // must not run files concurrently.
    fileParallelism: false,
    // No DATABASE_PATH any more: the database is PostgreSQL, and resolveUrl()
    // demands TEST_DATABASE_URL specifically so a test run cannot be pointed at
    // production by an inherited DATABASE_URL. Supply it in the environment.
    env: {}
  },
  // Component tests use JSX without importing React, as the app does. esbuild
  // otherwise emits the classic React.createElement transform and every .tsx
  // test fails on "React is not defined".
  esbuild: {
    jsx: "automatic"
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
