import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "mobile", environment: "node", include: ["test/**/*.test.ts"] },
});
