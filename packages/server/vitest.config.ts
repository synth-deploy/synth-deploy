import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 49,
        branches: 35,
        functions: 55,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@synth-deploy/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
});
