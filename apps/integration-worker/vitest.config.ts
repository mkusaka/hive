import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = new URL("../../packages/db/migrations", import.meta.url).pathname;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrations),
          GITHUB_WEBHOOK_SECRET: "test-github-secret",
          SLACK_SIGNING_SECRET: "test-slack-secret",
        },
        compatibilityDate: "2026-08-15",
      },
    })),
  ],
  test: {
    name: "integration-worker",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
