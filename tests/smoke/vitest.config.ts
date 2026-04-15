import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: path.dirname(new URL(import.meta.url).pathname),
    include: ['*.test.ts'],
    testTimeout: 300_000, // agent-dispatched tests can take minutes
    hookTimeout: 30_000,
    // Agent tests share the orchestrator session — run files sequentially
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
