import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = new URL("../../packages/db/migrations", import.meta.url).pathname;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // The pool wraps Durable Object classes exported from `main`.
      main: "./src/index.ts",
      miniflare: {
        d1Databases: ["DB"],
        r2Buckets: ["R2"],
        durableObjects: { REALTIME: { className: "Realtime", useSQLite: true } },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrations),
          ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
          ACCESS_AUD: "test-aud",
        },
        compatibilityDate: "2026-08-15",
      },
    })),
  ],
  test: {
    name: "api-worker",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Miniflare D1 + R2 round trips on a cold CI runner exceed vitest's 5 s default (sessions.test.ts timed out once).
    testTimeout: 20_000,
  },
});
