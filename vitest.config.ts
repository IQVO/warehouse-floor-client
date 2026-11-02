import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      include: ["src/**/*.test.{ts,tsx}"],
      coverage: {
        provider: "v8",
        // Floor of the measured baseline (2026-11-02: 90.93/83.96/91.71/94.12),
        // so the suite meets them today and regressions fail `npm test`.
        thresholds: { statements: 90, branches: 83, functions: 91, lines: 94 },
      },
    },
  }),
);
