import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Test config for the frontend.
 *
 * `jsdom` rather than a browser: everything under test here is logic and
 * rendering, and a real browser would buy timing flakiness and a minute of
 * startup for behaviour jsdom already reproduces.
 *
 * The `@/` alias is duplicated from tsconfig because Vitest resolves imports
 * itself and does not read `paths`. If they drift, every import fails loudly at
 * collection time rather than silently resolving to the wrong file.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["{lib,components,app}/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "components/**/*.tsx"],
    },
  },
});
