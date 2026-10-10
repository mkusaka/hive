import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "executor",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
