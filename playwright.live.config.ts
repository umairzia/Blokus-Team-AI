import { defineConfig } from '@playwright/test';

// Smoke test of the deployed site (used after deployment). It only reads the
// page and plays an offline practice game; it never creates or touches online
// rooms. LIVE_URL defaults to the GitHub Pages address.
export default defineConfig({
  testDir: 'e2e/live',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 2,
  reporter: [['list']],
  outputDir: 'test-results/live',
  use: {
    baseURL: process.env.LIVE_URL ?? 'https://umairzia.github.io/Blokus-Team-AI/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'live' }],
});
