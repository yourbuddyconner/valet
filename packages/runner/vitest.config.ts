import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/opencode-manager.test.ts",
      "src/prompt.test.ts",
    ],
    testTimeout: 10_000,
  },
});
