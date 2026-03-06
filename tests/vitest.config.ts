import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: __dirname,
    include: ["integration/**/*.test.ts", "e2e/**/*.test.ts", "scenarios/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@synth-deploy/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
      "@synth-deploy/server": path.resolve(__dirname, "../packages/server/src"),
      "@synth-deploy/envoy": path.resolve(__dirname, "../packages/envoy/src"),
    },
  },
});
