import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // workflow-*.test.ts use bun:test and exercise Bun.spawn code paths —
    // they run via the `test:workflows` script under bun, not here.
    include: [
      "src/opencode-manager.test.ts",
      "src/prompt.test.ts",
      "src/iteration-path.test.ts",
      "src/agent-prompt-output.test.ts",
    ],
    testTimeout: 10_000,
  },
});
