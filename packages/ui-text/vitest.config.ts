import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "ui-text", environment: "node", include: ["test/**/*.test.ts"] },
});
