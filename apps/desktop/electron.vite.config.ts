import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript sources, so main bundles them instead of requiring them at runtime. Other
// dependencies stay external: the Claude Agent SDK finds its CLI next to its own files (headless executor mode).
const bundleWorkspace = {
  externalizeDeps: { exclude: ["@hive/cli", "@hive/contracts", "@hive/executor"] },
};

export default defineConfig({
  main: { build: bundleWorkspace },
  // A sandboxed preload must be CommonJS.
  preload: { build: { ...bundleWorkspace, rollupOptions: { output: { format: "cjs" } } } },
  // No React plugin: esbuild's automatic JSX runtime is enough (no fast refresh, no inline preamble for the CSP).
  renderer: { esbuild: { jsx: "automatic" } },
});
