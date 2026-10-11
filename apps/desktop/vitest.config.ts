import { defineConfig } from "vitest/config";

export default defineConfig({
  // No tsconfig.json here for the JSX setting (see electron.vite.config.ts).
  esbuild: { jsx: "automatic" },
  test: {
    name: "desktop",
    environment: "node",
    // test/ui/*.test.tsx opt into happy-dom per file.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
