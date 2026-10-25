import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/engine/**/*.test.ts', 'tests/ui/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ai',
          include: ['tests/ai/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'network',
          include: ['tests/network/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'firebase',
          include: ['tests/firebase/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // The emulator is shared: run the files one after another.
          fileParallelism: false,
        },
      },
    ],
  },
});
