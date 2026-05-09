import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/worker',
      'packages/shared',
      'packages/sdk',
    ],
  },
});
