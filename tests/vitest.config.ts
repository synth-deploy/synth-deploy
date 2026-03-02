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
      "@deploystack/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
      "@deploystack/command": path.resolve(__dirname, "../packages/command/src"),
      "@deploystack/envoy": path.resolve(__dirname, "../packages/envoy/src"),
    },
  },
});
