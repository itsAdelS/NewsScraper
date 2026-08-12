import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Isolate each test file so module mocks don't bleed across files.
    isolate: true,
    testTimeout: 10000,
  },
});
