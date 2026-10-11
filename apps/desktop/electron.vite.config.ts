import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript sources, so main bundles them instead of requiring them at runtime.
const bundleWorkspace = { externalizeDeps: { exclude: ["@hive/cli", "@hive/contracts"] } };

export default defineConfig({
  main: { build: bundleWorkspace },
  // A sandboxed preload must be CommonJS.
  preload: { build: { ...bundleWorkspace, rollupOptions: { output: { format: "cjs" } } } },
  // No React plugin: esbuild's automatic JSX runtime is enough (no fast refresh, no inline preamble for the CSP).
  renderer: { esbuild: { jsx: "automatic" } },
});
