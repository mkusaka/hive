import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = new URL("./migrations", import.meta.url).pathname;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrations) },
        compatibilityDate: "2026-08-15",
      },
    })),
  ],
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
